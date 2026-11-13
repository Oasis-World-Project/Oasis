// 工作流控制面的对外接口：任务单 → 规划（planning-service）或直接提交方案 → 调度可以跑的节点 →
// 收到运行结束就推进（讨论的下一轮、汇总、过关卡、原会话修复、最终验收）→ 实际失败或证据不足时明确交给用户处理。
// 用户可以随时停止 / 继续整个任务或一样成果、给它发话（单个节点的接口在 workflow-nodes.ts）；节点和连线不能编辑。
// 节点真正的执行在 harness；推进的规则在 engine/，各种节点怎么跑在 kinds/。
import { randomUUID } from 'node:crypto';
import type { Material } from '@oasis/contracts/canvas';
import type { AdjustmentRequestedData, CallSettledData } from '@oasis/contracts/events';
import type {
  Attention,
  CreateTaskInput,
  DecisionBody,
  TaskBody,
  TaskSummary,
  WorkflowVersionBody,
} from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { Snapshot, Writer } from '../repo/task-store.ts';
import { noEffects, type Effects } from './effects.ts';
import {
  ACTIVE,
  createEngine,
  FINAL,
  isRevising,
  toTaskBody,
  type EngineDeps,
} from './engine/index.ts';
import { isRoot, rootOf } from './groups.ts';

import { planToRows, validatePlan } from './plan.ts';
import { directRevision } from './revision-planner.ts';
import { createNodeApi } from './workflow-nodes.ts';
import { createPickApi } from './workflow-pick.ts';

/** 「需要处理」时某个选择不适用的说明 */
const UNAVAILABLE: Record<Attention['reason'], string> = {
  node_failed: '节点失败时可以继续、再试或取消',
  plan_failed: '工作流没排好时只能重新规划或取消',
  workflow_broken: '有成果的上游没做完，工作流走不下去了：只能取消任务',
  revision_plan: '修改方案只能确认，或者不改了',
};

const revising = () =>
  new HttpError(409, 'task_revising', '这份成果正在修改，等这次修改结束后再操作');

export function createWorkflowService(deps: EngineDeps) {
  const engine = createEngine(deps);
  const { store, logger } = deps;
  const { planning } = engine;

  async function owned(ownerId: string, taskId: string): Promise<Snapshot> {
    const snapshot = await store.get(taskId);
    if (!snapshot || snapshot.task.ownerId !== ownerId) {
      throw new HttpError(404, 'task_not_found', '没有这个任务');
    }
    return snapshot;
  }

  /** 调用方给定 ID 的任务已经建过：同一个人的原样返回；ID 被别人的任务占着就拒绝 */
  async function sameTask(body: CreateTaskInput): Promise<TaskBody | undefined> {
    const snapshot = body.id ? await store.get(body.id) : undefined;
    if (!snapshot) return undefined;
    if (snapshot.task.ownerId !== body.ownerId)
      throw new HttpError(409, 'task_id_taken', '这个任务 ID 已经被占用');
    return toTaskBody(snapshot);
  }

  /** 改任务（还没结束的）：确认归属 → 在事务里改 → 返回最新的任务 */
  async function change(
    ownerId: string,
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<TaskBody> {
    await owned(ownerId, taskId);
    await engine.transact(taskId, async (snapshot, w, fx) => {
      if (FINAL.includes(snapshot.task.status)) {
        throw new HttpError(409, 'task_finished', '任务已经结束了；要改的话请发起一个新任务');
      }
      if (snapshot.task.status === 'planning') {
        throw new HttpError(409, 'task_planning', 'AI 团队还在搭建工作流，请稍等');
      }
      if (snapshot.task.status === 'accepting') {
        throw new HttpError(409, 'task_accepting', '工作流已经跑完，正在做最后的验收，请稍等');
      }
      await fn(snapshot, w, fx);
    });
    return toTaskBody(await owned(ownerId, taskId));
  }

  return {
    onRunFinished: (result: Parameters<typeof engine.onRunFinished>[0]) =>
      engine.onRunFinished(result),

    /** 做成果的 AI 提出了跨成果的调整：交给规划员答一次 */
    onAdjustmentRequested: (data: AdjustmentRequestedData) => planning.adjust(data),

    /**
     * 一次属于任务的调用（模型、工具、沙箱和检查浏览器的算力）结算了：累加到任务和节点上，
     * 同一次调用只算一次。只记已经花了多少：没有预算、上限和提醒。
     */
    async onCallSettled(
      data: Pick<CallSettledData, 'callId' | 'taskId' | 'nodeId' | 'chargedMicro'>,
    ) {
      if (!(await store.get(data.taskId))) return;
      await engine.transact(data.taskId, async (snapshot, w) => {
        const node = data.nodeId ? snapshot.nodes.find((n) => n.id === data.nodeId) : undefined;
        const counted = await w.addSpend({
          callId: data.callId,
          nodeId: node?.id ?? null,
          chargedMicro: data.chargedMicro,
        });
        if (!counted) return;
        await w.setTask({ spentMicro: snapshot.task.spentMicro + data.chargedMicro });
        if (node) await w.setNode(node.id, { spentMicro: node.spentMicro + data.chargedMicro });
      });
    },

    /**
     * 建任务：给任务单的先规划（规划员排出方案后自动开跑）；
     * 直接给方案的校验后立即开跑。
     */
    async create(body: CreateTaskInput): Promise<TaskBody> {
      const id = body.id ?? randomUUID();
      // 同一个 ID 已经建过（确认任务单超时后重试）：原样返回，不建第二个
      const existing = body.id ? await sameTask(body) : undefined;
      if (existing) return existing;
      const base = {
        id,
        ownerId: body.ownerId,
        payerId: body.payerId,
        conversationId: body.conversationId ?? null,
        title: body.title,
        brief: body.brief,
        materials: body.materials,
      };
      if (body.sheet) {
        try {
          await store.create({
            task: {
              ...base,
              status: 'planning',
              sheet: body.sheet,
            },
            nodes: [],
            edges: [],
          });
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            // 同一个 ID 的两次请求同时到达：主键只放进一个，另一个返回它
            const raced = body.id ? await sameTask(body) : undefined;
            if (raced) return raced;
          }
          throw err;
        }
        // 规划员的提交（读经验手册、模型和工具目录）放到返回之后：建任务只等数据库，
        // 确认任务单不会因为它超时；提交失败由对账重试。
        const fx = noEffects();
        await store.transact(id, (snapshot, w) => planning.begin(snapshot, w, fx));
        void engine
          .runEffects(fx)
          .catch((err: unknown) => logger.error({ err, taskId: id }, '提交规划员失败，等对账重试'));
        return toTaskBody((await store.get(id)) as Snapshot);
      }
      const plan = body.plan as NonNullable<typeof body.plan>;
      validatePlan(plan);
      const rows = planToRows(plan);
      await store.create({
        task: { ...base, status: 'running', sheet: null },
        nodes: rows.nodes,
        edges: rows.edges,
      });
      await engine.transact(id, (snapshot, w, fx) => engine.schedule(snapshot, w, fx));
      return toTaskBody((await store.get(id)) as Snapshot);
    },

    async list(ownerId: string): Promise<TaskSummary[]> {
      const rows = await store.listByOwner(ownerId, 50);
      return rows.map(({ task, nodes }) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        // 只数工作流图里的节点：展开出来的条目、各版算在父节点里
        nodesDone: nodes.filter((n) => isRoot(n) && n.status === 'succeeded').length,
        nodesTotal: nodes.filter(isRoot).length,
        spentMicro: task.spentMicro,
        // 从发出修改到新版交付（或不改了）都算修改中
        revising: isRevising(task),
        createdAt: task.createdAt.toISOString(),
      }));
    },

    /** 这些上传文件里，哪些是这个人某个任务的素材（conversation 删私聊时留着它们） */
    materialsInUse: (ownerId: string, uploadIds: string[]) =>
      store.materialsInUse(ownerId, uploadIds),

    get: async (ownerId: string, taskId: string) => toTaskBody(await owned(ownerId, taskId)),

    /** 内部（conversation 发交付消息用）：不查归属 */
    async getInternal(taskId: string): Promise<TaskBody> {
      const snapshot = await store.get(taskId);
      if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
      return toTaskBody(snapshot);
    },

    /** 删除任务（真删除）：还没结束的先取消（停掉正在跑的运行），再连同成果、工作流和中间产物一起删 */
    async remove(ownerId: string, taskId: string): Promise<void> {
      await owned(ownerId, taskId);
      await engine.transact(taskId, async (snapshot, w, fx) => {
        if (!FINAL.includes(snapshot.task.status)) await engine.cancelAll(snapshot, w, fx);
      });
      await store.remove(taskId);
      logger.info({ taskId }, '用户删除了任务和它的成果');
    },

    /**
     * 修改成果：在原任务里改；附件并进任务素材。意见指得到由 AI 做的成果时，直接交给
     * 做它的 AI 接着原会话改、马上开跑；跨几样成果或定不下来时交给规划员看上一版决定怎么改，排好后等用户确认。
     * 新版交付后 canvas 原地更新成果，链接不变。
     */
    async revise(
      taskId: string,
      body: { ownerId: string; request: string; materials: Material[]; nodeIds?: string[] },
    ): Promise<TaskBody> {
      await engine.transact(taskId, async (snapshot, w, fx) => {
        const { task } = snapshot;
        if (task.ownerId !== body.ownerId)
          throw new HttpError(404, 'task_not_found', '没有这个任务');
        if (task.revision) throw revising();
        // 已结束或已停下的任务都能接着改（修改中途停下、取消后，成果还是上一版）
        if (!FINAL.includes(task.status) && task.status !== 'stopped')
          throw new HttpError(
            409,
            'task_not_delivered',
            '这个任务还没交付或正在修改，等它结束后再改',
          );
        if (!task.sheet || snapshot.nodes.length === 0)
          throw new HttpError(409, 'task_not_revisable', '这个任务没有可以接着改的工作流');
        const known = new Set(task.materials.map((m) => m.uploadId));
        // 意见针对的成果：批注所在成果的节点；展开出来的条目、做几版里的一版算在它所在的那个节点上
        const roots = snapshot.nodes.filter(isRoot);
        const targets = [
          ...new Set(
            (body.nodeIds ?? []).flatMap((id) => {
              const node = snapshot.nodes.find((n) => n.id === id);
              return node ? [rootOf(snapshot.nodes, node).id] : [];
            }),
          ),
        ];
        const keyOf = new Map(roots.map((n) => [n.id, n.key]));
        const direct = directRevision({
          nodes: roots,
          edges: snapshot.edges,
          deliverables: Object.fromEntries(
            task.deliverables.flatMap((d) =>
              d.nodeId && keyOf.has(d.nodeId) ? [[d.name, keyOf.get(d.nodeId)!]] : [],
            ),
          ),
          targets,
        });
        await w.setTask({
          materials: [...task.materials, ...body.materials.filter((m) => !known.has(m.uploadId))],
          revision: {
            version: task.version + 1,
            request: body.request,
            nodeIds: body.nodeIds ?? [],
            previousStatus: task.status,
            ...direct,
          },
          planAttempts: 0,
        });
        logger.info({ taskId, direct: Boolean(direct) }, '收到修改意见');
        // 指得到做成果的 AI：直接按意见改
        if (direct) return engine.applyRevision(snapshot, w, fx);
        // 否则交给规划员看上一版决定怎么改，排好后先给用户确认
        await planning.begin(snapshot, w, fx);
      });
      return toTaskBody(await owned(body.ownerId, taskId));
    },

    /** 冻结的某一版工作流 */
    async version(ownerId: string, taskId: string, version: number): Promise<WorkflowVersionBody> {
      await owned(ownerId, taskId);
      const row = await store.getVersion(taskId, version);
      if (!row) throw new HttpError(404, 'version_not_found', '没有这一版');
      return {
        version: row.version,
        request: row.request,
        createdAt: row.createdAt.toISOString(),
        frozenAt: row.frozenAt.toISOString(),
        nodes: row.nodes,
        edges: row.edges,
        spentMicro: row.spentMicro,
      };
    },

    /** 工作流页显示用的名字：型号是哪个 AI、工具叫什么 */
    names: (userId: string) => planning.names(userId),

    /** 运行整个工作流 */
    run: (ownerId: string, taskId: string) =>
      change(ownerId, taskId, (snapshot, w, fx) => engine.runAll(snapshot, w, fx)),

    /** 停止整个任务：在跑的节点都停下（存下产出，会话留在持久工作目录里），之后点运行接着做 */
    stop: (ownerId: string, taskId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        for (const node of snapshot.nodes.filter((n) => ACTIVE.includes(n.status))) {
          await engine.halt(snapshot, w, node, fx);
        }
        if (snapshot.task.status === 'running') {
          await w.setTask({ status: 'stopped', attention: null });
        }
      }),

    /** 取消整个任务：还没结束的节点全部取消，正在跑的运行通知 harness 停下 */
    async cancel(ownerId: string, taskId: string): Promise<TaskBody> {
      await owned(ownerId, taskId);
      await engine.transact(taskId, async (snapshot, w, fx) => {
        // 修改还在规划或等确认：取消的是这次修改，不是整个任务
        if (snapshot.task.revision) await engine.cancelRevision(snapshot, w, fx);
        else if (!FINAL.includes(snapshot.task.status)) await engine.cancelAll(snapshot, w, fx);
      });
      return toTaskBody(await owned(ownerId, taskId));
    },

    /** 「需要处理」时的三选一 */
    decide: (ownerId: string, taskId: string, { choice }: DecisionBody) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const { task } = snapshot;
        if (task.status !== 'needs_attention' || !task.attention) {
          throw new HttpError(409, 'nothing_to_decide', '这个任务现在不需要你处理');
        }
        // 修改方案等确认、或修改没排出方案时：「不改了」只取消这次修改；「确认修改」按方案开跑
        if (task.revision && choice === 'cancel') return engine.cancelRevision(snapshot, w, fx);
        if (choice === 'cancel') return engine.cancelAll(snapshot, w, fx);
        const { reason, nodeId } = task.attention;
        if (reason === 'revision_plan' && choice === 'continue' && task.revision?.plan)
          return engine.applyRevision(snapshot, w, fx);
        if (reason === 'node_failed') {
          const failed = snapshot.nodes.find((n) => n.id === nodeId && n.status === 'failed');
          if (failed) {
            await w.setNode(
              failed.id,
              choice === 'continue'
                ? {
                    // 用现在的结果继续：这个节点算完成，有产出就交给下游，没有就不交
                    status: 'succeeded',
                    finishedAt: new Date(),
                    warning: '没能完成，按你的选择用现有的结果继续往下做',
                  }
                : { status: 'waiting', attempts: 0, reworks: 0, warning: null },
            );
          }
          await w.setTask({ status: 'running', attention: null });
          return engine.schedule(snapshot, w, fx);
        }
        if (reason === 'plan_failed' && choice === 'retry') return planning.retry(snapshot, w, fx);
        throw new HttpError(409, 'choice_unavailable', UNAVAILABLE[reason]);
      }),

    ...createNodeApi({ engine, owned, change }),
    ...createPickApi({ engine, owned }),

    /**
     * 对账（启动时和每分钟）：防止 harness 的结束事件丢了、运行没提交出去、关卡检查中途断了。
     */
    async reconcile(olderThanMs = 15_000): Promise<void> {
      const before = new Date(Date.now() - olderThanMs);
      for (const run of await store.listActiveRuns(before)) {
        await engine
          .reconcileRun(run)
          .catch((err: unknown) => logger.warn({ err, runId: run.id }, '对账失败，下次再试'));
      }
      await planning.reconcile(before);
      for (const task of await store.listStale('accepting', before)) {
        await engine
          .runAcceptance(task.id)
          .catch((err: unknown) =>
            logger.warn({ err, taskId: task.id }, '整体验收重试失败，下次再试'),
          );
      }
      for (const node of await store.listCheckingNodes(before)) {
        if (!node.currentRunId) continue;
        await engine
          .runGate(node.taskId, node.id, node.currentRunId)
          .catch((err: unknown) => logger.warn({ err, nodeId: node.id }, '关卡重试失败，下次再试'));
      }
      // 展开节点读清单中途断了：再读一次
      for (const node of await store.listExpanding(before)) {
        await engine
          .expand({ taskId: node.taskId, nodeId: node.id })
          .catch((err: unknown) => logger.warn({ err, nodeId: node.id }, '展开重试失败，下次再试'));
      }
    },
  };
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
