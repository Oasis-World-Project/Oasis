// 规划（ADR 0005 §4）：任务从用户确认的任务单开始 → 规划员（一次 harness 运行）把方案写进 out/plan.json
// → 规划门检查 → 没过就接着原会话改，次数用完交给用户 → 通过就建节点和连线、开跑。
import { randomUUID } from 'node:crypto';
import { Catalog, PlaybookList, type Playbook } from '@oasis/contracts/agent';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { AdjustmentRequestedData, RunFinishedData } from '@oasis/contracts/events';
import { RunBody, ExecutionEnvironment } from '@oasis/contracts/harness';
import {
  ADJUST_TOOL,
  ExecutionModels,
  ToolList,
  type ToolEntry,
} from '@oasis/contracts/model-gateway';
import type { WorkflowNames } from '@oasis/contracts/task';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { NodeRun, Snapshot, TaskStore, Writer } from '../repo/task-store.ts';
import {
  ADJUST_FILE,
  adjustNote,
  adjustPrompt,
  adjustRefusal,
  checkAdjust,
  replyOf,
  workflowOf,
} from './adjust.ts';
import type { Effects, Engine, PlannerJob } from './effects.ts';
import { materialPaths } from './materials.ts';
import { planToRows } from './plan.ts';
import {
  checkPlan,
  PLAN_FILE,
  plannerPrompt,
  revisePrompt,
  type PlannerPlan,
  type PricedModel,
} from './planner.ts';
import { checkRevisionPlan, revisionPlannerPrompt } from './revision-planner.ts';

export interface PlanningConfig {
  /** 规划员型号：不分档，一律最强型号（用户 2026-11-07 决定） */
  planner: string;
  /** 节点默认用的模型 */
  defaultModel: string;
}

const RUN_FINAL = ['succeeded', 'failed', 'cancelled', 'stopped'];

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

  /** 替这个用户向 model-gateway 要目录：它按他的模型范围（「只用国内模型」，ADR 0027）过滤 */
  const listedFor = (userId: string) => ({ headers: { [OASIS_HEADERS.payerId]: userId } });

  /** 这个用户的 AI 团队能挑的模型：已接入、能执行、在他的模型范围里的，带上典型单价 */
  async function catalog(userId: string): Promise<PricedModel[]> {
    const { models } = await deps.agent.json('GET', '/internal/models/catalog', {
      schema: Catalog,
    });
    const execution = await deps.modelGateway.json('GET', '/internal/v1/models/execution', {
      ...listedFor(userId),
      schema: ExecutionModels,
    });
    const listed = new Map(execution.models.map((m) => [m.id, m]));
    return models.flatMap((m) => {
      const model = listed.get(m.providerModel);
      if (!model) return [];
      // 节点里能直接读什么（文字、图片）照供应商目录，各档次的型号都有；不用手写的清单
      return [
        {
          ...m,
          inputs: model.input,
          ...(model.node ? { node: model.node } : {}),
          ...(model.measured ? { measured: model.measured } : {}),
        },
      ];
    });
  }

  /** 目录不可读时等待恢复，不能把未知当成没有工具而编造替代方案。 */
  async function allTools(userId: string): Promise<ToolEntry[]> {
    return deps.modelGateway
      .json('GET', '/internal/v1/tools', { ...listedFor(userId), schema: ToolList })
      .then((r) => r.tools.filter((t) => t.available));
  }

  /** 规划员排方案能用的工具：「提出调整」只给做成果的 AI 用，方案里不能写 */
  const tools = async (userId: string) =>
    (await allTools(userId)).filter((t) => t.key !== ADJUST_TOOL);

  /** 把答复写回提出调整的那个长任务（model-gateway），沙箱里等着的 AI 就拿到了 */
  const answer = (jobId: string, text: string) =>
    deps.modelGateway.json('POST', `/internal/v1/tools/jobs/${jobId}/answer`, { body: { text } });

  /**
   * 场景经验手册：不再让 Jev 逐份判断，全部放进规划员的 in/playbooks/，
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
    return workflowOf(snapshot);
  }

  /** 交给 harness（事务外）。harness 明确拒绝时按规划员失败处理。 */
  async function submit(job: PlannerJob): Promise<void> {
    const { task } = job;
    try {
      const guides = job.revise ? [] : await playbooks(task.id);
      const resources = async () => ({
        catalog: await catalog(task.payerId),
        tools: await tools(task.payerId),
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

  /** 读规划员写在 out/ 里的文件（方案、对调整的答复）；没有这个文件返回 undefined */
  async function readOut(runId: string, file = PLAN_FILE): Promise<string | undefined> {
    try {
      const response = await harness.stream('GET', `/internal/runs/${runId}/files/${file}`);
      return await response.text();
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return undefined;
      throw err;
    }
  }

  /** 方案通过了：建节点和连线，开跑 */
  async function adopt(snapshot: Snapshot, w: Writer, fx: Effects, plan: PlannerPlan) {
    const sheet = snapshot.task.sheet!;
    const rows = planToRows(plan);
    for (const node of rows.nodes) await w.addNode(node);
    for (const edge of rows.edges) await w.addEdge(edge);
    const idOf = new Map(rows.nodes.map((n) => [n.key, n.id]));
    await w.setTask({
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
    const toolList = result.status === 'succeeded' ? await tools(task.payerId) : [];
    const models = result.status === 'succeeded' ? await catalog(task.payerId) : [];
    const environment =
      result.status === 'succeeded'
        ? await harness.json('GET', '/internal/execution/environment', {
            schema: ExecutionEnvironment,
          })
        : undefined;
    if (task.revision) {
      const before = await previous(task.id);
      const revised: ReturnType<typeof checkRevisionPlan> =
        result.status === 'succeeded'
          ? checkRevisionPlan(await readOut(result.runId), {
              sheet: task.sheet!,
              catalog: models,
              tools: toolList,
              ...(environment ? { environment } : {}),
              nodes: before.nodes,
              edges: before.edges,
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
    const checked: ReturnType<typeof checkPlan> =
      result.status === 'succeeded'
        ? checkPlan(await readOut(result.runId), task.sheet!, models, toolList, environment)
        : { problems: [`规划员没跑完：${result.error ?? result.status}`] };
    await engine.transact(task.id, async (snapshot, w, fx) => {
      const current = snapshot.task;
      if (current.status !== 'planning' || current.plannerRunId !== result.runId) return;
      if ('plan' in checked) {
        logger.info({ taskId: current.id, nodes: checked.plan.nodes.length }, '方案通过规划门');
        return adopt(snapshot, w, fx, checked.plan);
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

    /** 这个用户现在能用的工具（展开节点核对每条的参数用） */
    tools,

    /** 工作流页显示用的名字：型号是哪个 AI、工具叫什么 */
    async names(userId: string): Promise<WorkflowNames> {
      const [models, available] = await Promise.all([catalog(userId), allTools(userId)]);
      return {
        models: models.map(({ key, name, providerModel }) => ({ key, name, providerModel })),
        tools: available.map(({ key, name }) => ({ key, name })),
      };
    },

    /**
     * 做成果的 AI 提出了一条调整（ADR 0030 §3.7）：开一次规划员运行来答，记在提出的那样成果上。
     * 现在不能调整的直接把原因答复回去。同一条重复到达只处理一次。
     */
    async adjust(request: AdjustmentRequestedData): Promise<void> {
      const before = await store.get(request.taskId);
      if (!before) return;
      const earlier = await store.listNodeRuns(request.taskId, request.nodeId);
      if (earlier.some((r) => r.meta.adjust?.jobId === request.jobId)) return;
      const { payerId } = before.task;
      const resources = {
        catalog: await catalog(payerId),
        tools: await tools(payerId),
        playbooks: [],
        defaultModel: config.defaultModel,
        environment: await harness.json('GET', '/internal/execution/environment', {
          schema: ExecutionEnvironment,
        }),
      };
      let refusal: string | undefined;
      await engine.transact(request.taskId, async (snapshot, w, fx) => {
        const node = snapshot.nodes.find((n) => n.id === request.nodeId);
        refusal = adjustRefusal(snapshot, node, request.runId);
        if (refusal || !node) return;
        const record = {
          model: config.planner,
          prompt: adjustPrompt({
            ...resources,
            ...workflowOf(snapshot),
            brief: snapshot.task.brief,
            sheet: snapshot.task.sheet!,
            from: node,
            want: request.want,
            why: request.why,
          }),
          inputsFrom: [],
        };
        const runId = randomUUID();
        await w.addRun({
          id: runId,
          nodeId: node.id,
          attempt: node.attempts,
          purpose: 'adjust',
          status: 'pending',
          meta: { adjust: { jobId: request.jobId, want: request.want, why: request.why } },
          request: record,
        });
        await w.setNode(node.id, {
          config: { ...node.config, adjust: adjustNote(request.want, true) },
        });
        fx.submit.push({ runId, task: snapshot.task, nodeId: node.id, request: record });
      });
      if (refusal) await answer(request.jobId, refusal);
    },

    /**
     * 答复调整的那次规划员运行结束了：按它的答复改工作流，再把答复写回给提出的 AI。
     * 答复先记在运行上再写回；写回失败时事件会重投，那时只补发没送到的答复。
     */
    async onAdjusted(
      found: NodeRun,
      result: Pick<RunFinishedData, 'runId' | 'status' | 'error' | 'outputs' | 'summary'>,
    ): Promise<void> {
      const meta = found.meta.adjust;
      if (!meta) return;
      let reply = meta.reply;
      if (found.status === 'pending' || found.status === 'running') {
        const task = (await store.get(found.taskId))?.task;
        if (!task) return;
        const gate =
          result.status === 'succeeded'
            ? {
                text: await readOut(result.runId, ADJUST_FILE),
                catalog: await catalog(task.payerId),
                tools: await tools(task.payerId),
                environment: await harness.json('GET', '/internal/execution/environment', {
                  schema: ExecutionEnvironment,
                }),
              }
            : undefined;
        const deliver: { runId: string; text: string }[] = [];
        await engine.transact(found.taskId, async (snapshot, w, fx) => {
          const run = snapshot.activeRuns.find((r) => r.id === found.id);
          if (!run) return; // 已经处理过
          const { status, revision, sheet } = snapshot.task;
          const checked = !gate
            ? { problems: [`规划员没跑完：${result.error ?? result.status}`] }
            : status !== 'running' || revision || !sheet
              ? { problems: ['任务已经不在运行'] }
              : checkAdjust(gate.text, { ...gate, ...workflowOf(snapshot), sheet });
          reply =
            'problems' in checked
              ? `这次调整没有生效：${checked.problems.slice(0, 3).join('；')}`
              : replyOf(checked);
          await w.setRun(run.id, {
            status: result.status,
            summary: result.summary,
            error: result.error,
            outputs: result.outputs,
            finishedAt: new Date(),
            meta: { ...run.meta, adjust: { ...meta, reply } },
          });
          const from = snapshot.nodes.find((n) => n.id === run.nodeId);
          if (from)
            await w.setNode(from.id, { config: { ...from.config, adjust: adjustNote(reply) } });
          logger.info({ taskId: found.taskId, nodeId: run.nodeId, reply }, '规划员答复了调整');
          if ('problems' in checked) await engine.schedule(snapshot, w, fx);
          else await engine.applyAdjust(snapshot, w, fx, checked, deliver);
        });
        for (const d of deliver)
          await harness
            .json('POST', `/internal/runs/${d.runId}/messages`, { body: { text: d.text } })
            .catch((err: unknown) =>
              logger.warn({ err, runId: d.runId }, '调整的说明没送到正在做的 AI'),
            );
      }
      if (!reply || meta.answered) return;
      await answer(meta.jobId, reply);
      const answered = { ...found.meta, adjust: { ...meta, reply, answered: true } };
      await store.transact(found.taskId, (_snapshot, w) => w.setRun(found.id, { meta: answered }));
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
