// 规划（ADR 0005 §4）：任务从用户确认的任务单开始 → 规划员（一次 harness 运行）把方案写进 out/plan.json
// → 规划门检查 → 没过就接着原会话改，次数用完交给用户 → 通过就建节点和连线、算预估、开跑。
import { randomUUID } from 'node:crypto';
import { Catalog, PlaybookList, type Playbook } from '@oasis/contracts/agent';
import type { RunFinishedData } from '@oasis/contracts/events';
import { RunBody, ExecutionEnvironment } from '@oasis/contracts/harness';
import { ExecutionModels, ToolList, type ToolEntry } from '@oasis/contracts/model-gateway';
import type { WorkflowOptions } from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { Snapshot, TaskStore, Writer } from '../repo/task-store.ts';
import type { Effects, Engine, PlannerJob } from './effects.ts';
import { materialPaths } from './materials.ts';
import { planToRows } from './plan.ts';
import {
  checkPlan,
  estimatePlan,
  PLAN_FILE,
  plannerPrompt,
  revisePrompt,
  type PlannerPlan,
} from './planner.ts';
import type { Fallback, PricedModel } from './quote.ts';
import { checkRevisionPlan, estimateRevision, revisionPlannerPrompt } from './revision-planner.ts';

export interface PlanningConfig {
  /** 规划员型号：不分档，一律最强型号（用户 2026-11-07 决定） */
  planner: string;
  /** 节点默认用的模型 */
  defaultModel: string;
  /** 什么记录都没有时的估价兜底 */
  fallback: Fallback;
}

const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];
const Unavailable = z.object({ models: z.array(z.string()) });

export function createPlanning(deps: {
  store: TaskStore;
  harness: ServiceClient;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  engine: Engine;
  config: PlanningConfig;
  logger: Logger;
}) {
  const { store, harness, engine, config, logger } = deps;

  /** 规划员能挑的模型：已接入的，去掉在当前网络用不了的（查不到时不排除），带上典型单价 */
  async function catalog(): Promise<PricedModel[]> {
    const { models } = await deps.agent.json('GET', '/internal/models/catalog', {
      schema: Catalog,
    });
    const execution = await deps.modelGateway.json('GET', '/internal/v1/models/execution', {
      schema: ExecutionModels,
    });
    const node = new Map(execution.models.map((m) => [m.id, m.node]));
    const blocked = await deps.modelGateway
      .json('GET', '/internal/v1/models/unavailable', { schema: Unavailable })
      .then((r) => new Set(r.models))
      .catch((err: unknown) => {
        logger.warn({ err }, '查不到哪些模型用不了，不排除');
        return new Set<string>();
      });
    // 地区限制按厂商生效（同一家的型号要么都能用要么都不能用）：一个型号被拒，这家的其他型号也排除
    const vendorOf = (model: string) => model.split('/')[0];
    const blockedVendors = new Set([...blocked].map(vendorOf));
    return models
      .filter((m) => node.has(m.providerModel) && !blockedVendors.has(vendorOf(m.providerModel)))
      .map((m) => {
        const rate = node.get(m.providerModel);
        return rate ? { ...m, node: rate } : m;
      });
  }

  /** 目录不可读时等待恢复，不能把未知当成没有工具而编造替代方案。 */
  async function tools(): Promise<ToolEntry[]> {
    return deps.modelGateway
      .json('GET', '/internal/v1/tools', { schema: ToolList })
      .then((r) => r.tools.filter((t) => t.available));
  }

  /**
   * 场景经验手册（ADR 0016 §6）：不再让 Jev 逐份判断，全部放进规划员的 in/playbooks/，
   * 说明里列名字和适用范围，由规划员自己挑着读。读不到手册就不附，规划照常进行。
   */
  async function playbooks(taskId: string): Promise<Playbook[]> {
    try {
      return (await deps.agent.json('GET', '/internal/playbooks', { schema: PlaybookList }))
        .playbooks;
    } catch (err) {
      logger.warn({ err, taskId }, '读不到经验手册，这次不附');
      return [];
    }
  }

  /** 在事务里开一次规划员运行（从头排，或接着上一次改） */
  async function open(snapshot: Snapshot, w: Writer, fx: Effects, revise?: PlannerJob['revise']) {
    const runId = randomUUID();
    await w.setTask({
      status: 'planning',
      attention: null,
      plannerRunId: runId,
      planAttempts: snapshot.task.planAttempts + 1,
    });
    fx.plan.push({ task: snapshot.task, runId, ...(revise ? { revise } : {}) });
  }

  /** 上一版工作流：修改的规划要看（ADR 0022） */
  async function previous(taskId: string) {
    const snapshot = await store.get(taskId);
    if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
    const keyOf = new Map(snapshot.nodes.map((n) => [n.id, n.key]));
    return {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      deliverables: Object.fromEntries(
        snapshot.task.deliverables.flatMap((d) =>
          d.nodeId && keyOf.has(d.nodeId) ? [[d.name, keyOf.get(d.nodeId)!]] : [],
        ),
      ),
    };
  }

  /** 交给 harness（事务外）。harness 明确拒绝时按规划员失败处理。 */
  async function submit(job: PlannerJob): Promise<void> {
    const { task } = job;
    try {
      const guides = job.revise ? [] : await playbooks(task.id);
      const resources = async () => ({
        catalog: await catalog(),
        tools: await tools(),
        playbooks: guides,
        defaultModel: config.defaultModel,
        environment: await harness.json('GET', '/internal/execution/environment', {
          schema: ExecutionEnvironment,
        }),
      });
      const revision = task.revision;
      let prompt: string;
      if (job.revise) prompt = revisePrompt(job.revise.problems);
      else if (revision) {
        const before = await previous(task.id);
        const keyOf = new Map(before.nodes.map((n) => [n.id, n.key]));
        prompt = revisionPlannerPrompt({
          ...(await resources()),
          ...before,
          brief: task.brief,
          sheet: task.sheet!,
          request: revision.request,
          targets: revision.nodeIds.flatMap((id) => (keyOf.has(id) ? [keyOf.get(id)!] : [])),
        });
      } else
        prompt = plannerPrompt({ ...(await resources()), brief: task.brief, sheet: task.sheet! });
      await harness.json('POST', '/internal/runs', {
        body: {
          runId: job.runId,
          payerId: task.payerId,
          taskId: task.id,
          model: config.planner,
          // 规划员一律用最高思考档；只需写出方案交给规划门，单轮就够，不用持续目标（2026-11-07）
          reasoningEffort: 'max',
          prompt,
          inputs: guides.map((p) => ({
            path: `playbooks/${p.key}.md`,
            contentBase64: Buffer.from(p.content).toString('base64'),
          })),
          materials: materialPaths(task.materials),
          ...(job.revise ? { continueFrom: job.revise.continueFrom } : {}),
        },
        requestId: job.runId,
        schema: RunBody,
      });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode >= 400 && err.statusCode < 500) {
        logger.warn({ err, taskId: task.id }, '规划员的运行被拒绝');
        await onFinished({ runId: job.runId, status: 'failed', error: err.message });
        return;
      }
      logger.warn({ err, taskId: task.id }, '提交规划员失败，等对账重试');
    }
  }

  /** 读规划员写的方案；没有这个文件返回 undefined */
  async function readPlan(runId: string): Promise<string | undefined> {
    try {
      const response = await harness.stream('GET', `/internal/runs/${runId}/files/${PLAN_FILE}`);
      return await response.text();
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  /**
   * 方案通过了：建节点和连线，算预估，按预算给每个节点分一份，开跑。
   * 预算只是参考（ADR 0016 §2）：预估再高也不暂停、不设上限。
   */
  async function adopt(
    snapshot: Snapshot,
    w: Writer,
    fx: Effects,
    plan: PlannerPlan,
    toolList: ToolEntry[],
    models: PricedModel[],
  ) {
    const { task } = snapshot;
    const sheet = task.sheet!;
    const { totalMicro, perNode } = estimatePlan(plan, models, toolList, config.fallback);
    const budget = sheet.budget?.micro;
    const rows = planToRows(plan, (key) =>
      budget && totalMicro > 0
        ? Math.max(1, Math.round((budget * (perNode.get(key) ?? 0)) / totalMicro))
        : undefined,
    );
    for (const node of rows.nodes) await w.addNode(node);
    for (const edge of rows.edges) await w.addEdge(edge);
    const idOf = new Map(rows.nodes.map((n) => [n.key, n.id]));
    await w.setTask({
      estimateMicro: totalMicro,
      budgetLimitMicro: null,
      deliverables: sheet.deliverables.map((d) => ({
        name: d.name,
        form: d.form,
        nodeId: idOf.get(plan.deliverables[d.name] ?? '') ?? null,
      })),
    });
    await w.setTask({ status: 'running', attention: null });
    await engine.schedule(snapshot, w, fx);
  }

  /** 规划员这次运行结束了（来自 harness 的事件或对账） */
  async function onFinished(
    result: Pick<RunFinishedData, 'runId' | 'status' | 'error'>,
  ): Promise<void> {
    const task = await store.findTaskByPlannerRun(result.runId);
    if (task?.status !== 'planning' || task.plannerRunId !== result.runId) return;
    // 事务外读方案、查模型和工具目录，事务里只做决定
    const toolList = result.status === 'succeeded' ? await tools() : [];
    const models = result.status === 'succeeded' ? await catalog() : [];
    const environment =
      result.status === 'succeeded'
        ? await harness.json('GET', '/internal/execution/environment', {
            schema: ExecutionEnvironment,
          })
        : undefined;
    if (task.revision) {
      const before = await previous(task.id);
      const revised =
        result.status === 'succeeded'
          ? checkRevisionPlan(await readPlan(result.runId), {
              sheet: task.sheet!,
              catalog: models,
              tools: toolList,
              ...(environment ? { environment } : {}),
              nodes: before.nodes,
            })
          : { problems: [`规划员没跑完：${result.error ?? result.status}`] };
      return engine.transact(task.id, async (snapshot, w, fx) => {
        const current = snapshot.task;
        if (current.status !== 'planning' || current.plannerRunId !== result.runId) return;
        if (!current.revision) return;
        if ('plan' in revised) {
          // 修改方案排好了：先给用户看，确认了才开跑（ADR 0022）
          logger.info({ taskId: current.id, changes: revised.changes }, '修改方案通过规划门');
          await w.setTask({
            revision: {
              ...current.revision,
              plan: revised.plan,
              changes: revised.changes,
              estimateMicro: estimateRevision(
                revised.plan,
                revised.workflow,
                models,
                toolList,
                config.fallback,
              ),
            },
            status: 'needs_attention',
            attention: { reason: 'revision_plan', nodeId: null, message: revised.plan.summary },
          });
          return;
        }
        if (result.status === 'succeeded')
          return open(snapshot, w, fx, { continueFrom: result.runId, problems: revised.problems });
        await w.setTask({
          status: 'needs_attention',
          attention: {
            reason: 'plan_failed',
            nodeId: null,
            message: `AI 团队没能排出修改方案：${revised.problems.slice(0, 3).join('；')}`,
          },
        });
      });
    }
    const checked =
      result.status === 'succeeded'
        ? checkPlan(await readPlan(result.runId), task.sheet!, models, toolList, environment)
        : { problems: [`规划员没跑完：${result.error ?? result.status}`] };
    await engine.transact(task.id, async (snapshot, w, fx) => {
      const current = snapshot.task;
      if (current.status !== 'planning' || current.plannerRunId !== result.runId) return;
      if ('plan' in checked) {
        logger.info({ taskId: current.id, nodes: checked.plan.nodes.length }, '方案通过规划门');
        return adopt(snapshot, w, fx, checked.plan, toolList, models);
      }
      if (result.status === 'succeeded') {
        logger.info(
          { taskId: current.id, problems: checked.problems },
          '方案没过规划门，让规划员改',
        );
        return open(snapshot, w, fx, { continueFrom: result.runId, problems: checked.problems });
      }
      await w.setTask({
        status: 'needs_attention',
        attention: {
          reason: 'plan_failed',
          nodeId: null,
          message: `AI 团队没能排出合适的工作流：${checked.problems.slice(0, 3).join('；')}`,
        },
      });
    });
  }

  return {
    /** 开始规划（建任务后、或用户选择重新规划时，在事务里调用） */
    begin: (snapshot: Snapshot, w: Writer, fx: Effects) => open(snapshot, w, fx),

    /** 用户选择重新规划：次数重新算 */
    async retry(snapshot: Snapshot, w: Writer, fx: Effects) {
      await w.setTask({ planAttempts: 0 });
      await open(snapshot, w, fx);
    },

    submit,
    onFinished,

    /** 报价和估价用的单价：带单价的模型目录和工具目录 */
    pricing: async () => ({ models: await catalog(), tools: await tools() }),

    /** 编辑节点时能选的模型和工具：和规划员看到的一样 */
    async options(): Promise<WorkflowOptions> {
      const [models, available] = await Promise.all([catalog(), tools()]);
      return {
        models: models.map(({ key, name, vendor, providerModel }) => ({
          key,
          name,
          vendor,
          providerModel,
        })),
        tools: available.map(({ key, name, description, unit, estimateMicro }) => ({
          key,
          name,
          description,
          unit,
          estimateMicro,
        })),
      };
    },

    /** 对账：规划员的结束事件丢了就补上；harness 根本没收到就重新开一次 */
    async reconcile(before: Date): Promise<void> {
      for (const task of await store.listStale('planning', before)) {
        try {
          let remote: RunBody | undefined;
          if (task.plannerRunId) {
            remote = await harness
              .json('GET', `/internal/runs/${task.plannerRunId}`, { schema: RunBody })
              .catch((err: unknown) => {
                if (err instanceof HttpError && err.statusCode === 404) return undefined;
                throw err;
              });
          }
          if (remote && RUN_FINAL.includes(remote.status)) {
            await onFinished({
              runId: remote.id,
              status: remote.status as RunFinishedData['status'],
              error: remote.error,
            });
          } else if (!remote) {
            await engine.transact(task.id, async (snapshot, w, fx) => {
              if (
                snapshot.task.status === 'planning' &&
                snapshot.task.plannerRunId === task.plannerRunId
              ) {
                await open(snapshot, w, fx);
              }
            });
          }
        } catch (err) {
          logger.warn({ err, taskId: task.id }, '对账规划员失败，下次再试');
        }
      }
    },
  };
}
