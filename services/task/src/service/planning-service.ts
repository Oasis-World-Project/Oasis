// 规划（ADR 0005 §4）：任务从用户确认的任务单开始 → 规划员（一次 harness 运行）把方案写进 out/plan.json
// → 规划门检查 → 没过就接着原会话改，次数用完交给用户 → 通过就建节点和连线、算预估、开跑。
import { randomUUID } from 'node:crypto';
import { Catalog, PlaybookList, type CatalogEntry, type Playbook } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { RunFinishedData } from '@oasis/contracts/events';
import { RunBody } from '@oasis/contracts/harness';
import { ToolList, type ToolEntry } from '@oasis/contracts/model-gateway';
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
  type EstimateRates,
  type PlannerPlan,
} from './planner.ts';

export interface PlanningConfig {
  /** 规划员用的模型（默认 DeepSeek） */
  model: string;
  /** 节点默认用的模型 */
  defaultModel: string;
  maxNodes: number;
  /** 规划员最多跑几次（含规划门退回后的修改） */
  maxAttempts: number;
  /** 判断任务属于哪类场景用的决策模型（Jev） */
  decisionModel: string;
  rates: EstimateRates;
  budgetMultiplier: number;
}

const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];
const Unavailable = z.object({ models: z.array(z.string()) });
const Answers = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().optional() }).loose()),
});
/** 「属于这类」的概率至少这么高才附上这份手册；最多附两份 */
const PLAYBOOK_THRESHOLD = 0.5;
const MAX_PLAYBOOKS = 2;

/** 微美元 → 给用户看的金额 */
export function dollars(micro: number): string {
  const usd = micro / 1_000_000;
  // 不到 1 美分的保留两位有效数字，避免显示成 $0.00
  return `$${usd >= 0.01 ? usd.toFixed(2) : String(Number(usd.toPrecision(2)))}`;
}

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

  /** 规划员能挑的模型：已接入的，去掉在当前网络用不了的（查不到时不排除） */
  async function catalog(): Promise<CatalogEntry[]> {
    const { models } = await deps.agent.json('GET', '/internal/models/catalog', {
      schema: Catalog,
    });
    const blocked = await deps.modelGateway
      .json('GET', '/internal/v1/models/unavailable', { schema: Unavailable })
      .then((r) => new Set(r.models))
      .catch((err: unknown) => {
        logger.warn({ err }, '查不到哪些模型用不了，不排除');
        return new Set<string>();
      });
    return models.filter((m) => !blocked.has(m.providerModel));
  }

  /** 规划员能用的外部工具：现在可用的（查不到时当作没有工具，方案照样能排） */
  async function tools(): Promise<ToolEntry[]> {
    return deps.modelGateway
      .json('GET', '/internal/v1/tools', { schema: ToolList })
      .then((r) => r.tools.filter((t) => t.available))
      .catch((err: unknown) => {
        logger.warn({ err }, '查不到工具目录，这次规划不用工具');
        return [];
      });
  }

  /**
   * 这个任务属于哪几类场景：每份手册问 Jev 一个「是否属于」（几乎不花钱，计入任务），
   * 挑出概率够高的。查不到手册或 Jev 出错就不附，规划照常进行。
   */
  async function playbooksFor(task: PlannerJob['task']): Promise<Playbook[]> {
    try {
      const { playbooks } = await deps.agent.json('GET', '/internal/playbooks', {
        schema: PlaybookList,
      });
      if (playbooks.length === 0) return [];
      const sheet = task.sheet!;
      const state = [
        `任务：${task.brief}`,
        `交付物：${sheet.deliverables.map((d) => `${d.name}（${d.form}）`).join('、')}`,
        `怎么算做好：${sheet.criteria.join('；')}`,
      ];
      const questions = Object.fromEntries(
        playbooks.map((p, i) => [
          `p${i}`,
          {
            type: 'noul',
            instructions: `这个任务的交付物里有没有这一类：${p.name}（${p.when}）`,
            criteria: { true: `有${p.name}的交付物`, false: `没有${p.name}的交付物` },
          },
        ]),
      );
      const { answers } = await deps.modelGateway.json('POST', '/internal/v1/decisions', {
        body: { model: config.decisionModel, state, questions },
        headers: { [OASIS_HEADERS.payerId]: task.payerId, [OASIS_HEADERS.taskId]: task.id },
        schema: Answers,
      });
      return playbooks
        .map((p, i) => ({ p, score: answers[`p${i}`]?.noul ?? 0 }))
        .filter((x) => x.score >= PLAYBOOK_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PLAYBOOKS)
        .map((x) => x.p);
    } catch (err) {
      logger.warn({ err, taskId: task.id }, '挑经验手册失败，这次不附手册');
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

  /** 交给 harness（事务外）。harness 明确拒绝时按规划员失败处理。 */
  async function submit(job: PlannerJob): Promise<void> {
    const { task } = job;
    try {
      const prompt = job.revise
        ? revisePrompt(job.revise.problems)
        : plannerPrompt({
            brief: task.brief,
            sheet: task.sheet!,
            catalog: await catalog(),
            tools: await tools(),
            playbooks: await playbooksFor(task),
            limits: { maxNodes: config.maxNodes, defaultModel: config.defaultModel },
          });
      await harness.json('POST', '/internal/runs', {
        body: {
          runId: job.runId,
          payerId: task.payerId,
          taskId: task.id,
          model: config.model,
          prompt,
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

  /** 方案通过了：建节点和连线，算预估和上限，开跑（预估超过用户设的上限时先问用户） */
  async function adopt(
    snapshot: Snapshot,
    w: Writer,
    fx: Effects,
    plan: PlannerPlan,
    toolList: ToolEntry[],
  ) {
    const { task } = snapshot;
    const sheet = task.sheet!;
    const rows = planToRows(plan);
    for (const node of rows.nodes) await w.addNode(node);
    for (const edge of rows.edges) await w.addEdge(edge);
    const idOf = new Map(rows.nodes.map((n) => [n.key, n.id]));
    const estimate = estimatePlan(plan, config.rates, toolList);
    const overUserCap = sheet.budgetMicro !== null && estimate > sheet.budgetMicro;
    await w.setTask({
      estimateMicro: estimate,
      budgetLimitMicro: sheet.budgetMicro ?? estimate * config.budgetMultiplier,
      deliverables: sheet.deliverables.map((d) => ({
        name: d.name,
        form: d.form,
        nodeId: idOf.get(plan.deliverables[d.name] ?? '') ?? null,
      })),
    });
    if (overUserCap) {
      await w.setTask({
        status: 'needs_attention',
        attention: {
          reason: 'over_estimate',
          nodeId: null,
          message: `预计要花 ${dollars(estimate)}，超过了你设的上限 ${dollars(sheet.budgetMicro ?? 0)}`,
        },
      });
      return;
    }
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
    const checked =
      result.status === 'succeeded'
        ? checkPlan(await readPlan(result.runId), task.sheet!, await catalog(), toolList, {
            maxNodes: config.maxNodes,
            defaultModel: config.defaultModel,
          })
        : { problems: [`规划员没跑完：${result.error ?? result.status}`] };
    await engine.transact(task.id, async (snapshot, w, fx) => {
      const current = snapshot.task;
      if (current.status !== 'planning' || current.plannerRunId !== result.runId) return;
      if ('plan' in checked) {
        logger.info({ taskId: current.id, nodes: checked.plan.nodes.length }, '方案通过规划门');
        return adopt(snapshot, w, fx, checked.plan, toolList);
      }
      if (current.planAttempts < config.maxAttempts) {
        logger.info(
          { taskId: current.id, problems: checked.problems },
          '方案没过规划门，让规划员改',
        );
        // 规划员跑完了但方案不合格：接着原会话改；规划员自己失败了：从头排
        return open(
          snapshot,
          w,
          fx,
          result.status === 'succeeded'
            ? { continueFrom: result.runId, problems: checked.problems }
            : undefined,
        );
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
