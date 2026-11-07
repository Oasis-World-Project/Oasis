// 工作流里单个节点和连线的接口（ADR 0004 §3、§7）：看运行过程、追问、取交出的文件、
// 改还没开始的节点和连线、只运行或只停止一个节点。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RunEventList } from '@oasis/contracts/harness';
import type {
  NodeRunBody,
  PlanNode,
  TaskBody,
  UpdateEdgeBody,
  UpdateNodeBody,
} from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { Snapshot, Writer } from '../repo/task-store.ts';
import type { Effects } from './effects.ts';
import { ACTIVE, toRunBody, type Engine } from './engine/index.ts';
import {
  checkDeleteEdge,
  checkNewEdge,
  checkNewNode,
  edgeChanges,
  edgeOf,
  nodeChanges,
  nodeOf,
  requireNotStarted,
} from './graph.ts';
import { kindOf } from './kinds/index.ts';
import { nodeRow } from './plan.ts';

export function createNodeApi(api: {
  engine: Engine;
  /** 确认任务属于这个人，返回快照 */
  owned(ownerId: string, taskId: string): Promise<Snapshot>;
  /** 改还没结束的任务：确认归属 → 在事务里改 → 返回最新的任务 */
  change(
    ownerId: string,
    taskId: string,
    fn: (snapshot: Snapshot, w: Writer, fx: Effects) => Promise<void>,
  ): Promise<TaskBody>;
}) {
  const { engine, owned, change } = api;
  const { store, harness, maxParallel } = engine.deps;

  /** 节点交出的一个文件：只能是它产出清单里有的（经 harness 读对象存储） */
  async function readFile(snapshot: Snapshot, nodeId: string, path: string) {
    const node = nodeOf(snapshot, nodeId);
    const runId = node.config.outputsRunId;
    if (!runId || !node.outputs.some((f) => f.path === path)) {
      throw new HttpError(404, 'file_not_found', '没有这个文件');
    }
    const response = await harness.stream(
      'GET',
      `/internal/runs/${runId}/files/${path.split('/').map(encodeURIComponent).join('/')}`,
    );
    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      size: node.outputs.find((file) => file.path === path)!.size,
      sha256: response.headers.get('x-oasis-file-sha256'),
      content: response.body ? Readable.fromWeb(response.body) : Readable.from([]),
    };
  }

  return {
    /** 节点的全部运行（第一次、重做、关卡退回修改、停止后继续、讨论的每次发言） */
    async nodeRuns(ownerId: string, taskId: string, nodeId: string): Promise<NodeRunBody[]> {
      // 修改时移出工作流的节点也能看（旧版查看，ADR 0022）：运行按任务过滤，归属已经核对
      await owned(ownerId, taskId);
      return (await store.listNodeRuns(taskId, nodeId)).map(toRunBody);
    },

    /** 一次运行的过程（按序号增量拉取）；不指定运行时看节点当前这次 */
    async nodeEvents(
      ownerId: string,
      taskId: string,
      nodeId: string,
      after: number,
      runId?: string,
    ) {
      const snapshot = await owned(ownerId, taskId);
      // 指定了运行时（旧版查看）不要求节点还在工作流里，下面核对运行属于这个节点
      const target = runId ?? nodeOf(snapshot, nodeId).currentRunId;
      if (!target) return { events: [] };
      if (runId) {
        const run = await store.findRun(runId);
        if (run?.taskId !== taskId || run.nodeId !== nodeId) {
          throw new HttpError(404, 'run_not_found', '这个节点没有这次运行');
        }
      }
      return harness.json('GET', `/internal/runs/${target}/events?after=${after}`, {
        schema: RunEventList,
      });
    },

    /**
     * 对节点追问 / 补充要求（ADR 0004 §7），只影响这一个节点：
     * - 运行中、能直接插话的节点（干活）：直接插进它的会话；
     * - 还没开始、已停止的节点，以及运行中不能插话的节点（讨论）：记下来（开跑、继续、下一轮时带上）；
     * - 正在过关卡、已结束的：不行。
     */
    async message(
      ownerId: string,
      taskId: string,
      nodeId: string,
      text: string,
    ): Promise<'delivered' | 'noted'> {
      await owned(ownerId, taskId);
      let deliverTo: string | undefined;
      await store.transact(taskId, async (snapshot, w) => {
        const node = nodeOf(snapshot, nodeId);
        const notable =
          ['draft', 'waiting', 'blocked', 'stopped'].includes(node.status) ||
          (node.status === 'running' && !kindOf(node).live);
        if (notable) {
          await w.setNode(node.id, { userNotes: [...node.userNotes, text] });
        } else if (node.status === 'running' && node.currentRunId) {
          deliverTo = node.currentRunId;
        } else {
          throw new HttpError(409, 'node_not_open', '这个节点现在不能追问');
        }
      });
      if (!deliverTo) return 'noted';
      try {
        await harness.json('POST', `/internal/runs/${deliverTo}/messages`, { body: { text } });
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 409) {
          throw new HttpError(409, 'node_not_ready', '这个节点正在启动或正在收尾，请稍后再说');
        }
        throw err;
      }
      return 'delivered';
    },

    /** 节点交出的网页的浏览器检查报告（关卡留档） */
    async applicationReport(ownerId: string, taskId: string, nodeId: string) {
      const snapshot = await owned(ownerId, taskId);
      const node = nodeOf(snapshot, nodeId);
      const runId = node.config.outputsRunId ?? node.currentRunId;
      if (!runId) throw new HttpError(404, 'check_not_found', '节点还没有可检查的产出');
      const response = await harness.stream(
        'POST',
        `/internal/runs/${runId}/application-check/report`,
        { body: { payerId: ownerId, taskId } },
      );
      return response.body ? Readable.fromWeb(response.body) : Readable.from([]);
    },

    /** 下载节点交出的一个文件（交付消息、工作流视图用） */
    async file(ownerId: string, taskId: string, nodeId: string, path: string) {
      return readFile(await owned(ownerId, taskId), nodeId, path);
    },

    /** 内部：取节点交出的一个文件（画布登记成果时复制，ADR 0007 §8） */
    async fileInternal(taskId: string, nodeId: string, path: string) {
      const snapshot = await store.get(taskId);
      if (!snapshot) throw new HttpError(404, 'task_not_found', '没有这个任务');
      return readFile(snapshot, nodeId, path);
    },

    /** 新建节点：先是「新建」状态，不会自动开跑 */
    createNode: (ownerId: string, taskId: string, body: PlanNode) =>
      change(ownerId, taskId, async (snapshot, w) => {
        checkNewNode(snapshot, body);
        await w.addNode(nodeRow(body, randomUUID(), 'draft'));
      }),

    /** 改还没开始的节点 */
    updateNode: (ownerId: string, taskId: string, nodeId: string, body: UpdateNodeBody) =>
      change(ownerId, taskId, async (snapshot, w) => {
        const node = nodeOf(snapshot, nodeId);
        requireNotStarted(node, '修改');
        await w.setNode(node.id, nodeChanges(node, body));
      }),

    /** 删还没开始的节点：它的进出连线留下断开的线头 */
    deleteNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        requireNotStarted(node, '删除');
        await w.deleteNode(node.id);
        await engine.schedule(snapshot, w, fx);
      }),

    /** 只运行这一个节点：跑完不自动往下（任务在整体运行时除外） */
    runNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        if (!['draft', 'waiting', 'stopped', 'failed'].includes(node.status)) {
          throw new HttpError(
            409,
            'node_not_runnable',
            node.status === 'blocked'
              ? `「${node.title}」前面的连线没接上`
              : `「${node.title}」现在不能运行`,
          );
        }
        if (node.status !== 'stopped') {
          const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
          const notReady = snapshot.edges
            .filter((e) => e.toNodeId === node.id)
            .some((e) => byId.get(e.fromNodeId ?? '')?.status !== 'succeeded');
          if (notReady) {
            throw new HttpError(409, 'upstream_not_ready', `「${node.title}」的上游还没完成`);
          }
        }
        const active = snapshot.nodes.filter((n) => ACTIVE.includes(n.status)).length;
        if (active >= maxParallel) {
          throw new HttpError(
            409,
            'too_many_running',
            `一个任务同时最多跑 ${maxParallel} 个节点，请等一会儿`,
          );
        }
        if (snapshot.task.status === 'needs_attention') {
          await w.setTask({ status: 'stopped', attention: null });
        }
        await engine.startNode(snapshot, w, node, fx);
      }),

    /** 停止一个节点；其他支路照常跑 */
    stopNode: (ownerId: string, taskId: string, nodeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const node = nodeOf(snapshot, nodeId);
        if (!ACTIVE.includes(node.status)) {
          throw new HttpError(409, 'node_not_running', `「${node.title}」没有在跑`);
        }
        await engine.halt(snapshot, w, node, fx);
        await engine.schedule(snapshot, w, fx);
      }),

    createEdge: (ownerId: string, taskId: string, from: string, to: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        checkNewEdge(snapshot, from, to);
        await w.addEdge({ id: randomUUID(), fromNodeId: from, toNodeId: to });
        await engine.schedule(snapshot, w, fx);
      }),

    /** 接上线头 / 改连线的一端 */
    updateEdge: (ownerId: string, taskId: string, edgeId: string, body: UpdateEdgeBody) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const edge = edgeOf(snapshot, edgeId);
        await w.setEdge(edge.id, edgeChanges(snapshot, edge, body));
        await engine.schedule(snapshot, w, fx);
      }),

    deleteEdge: (ownerId: string, taskId: string, edgeId: string) =>
      change(ownerId, taskId, async (snapshot, w, fx) => {
        const edge = edgeOf(snapshot, edgeId);
        checkDeleteEdge(snapshot, edge);
        await w.deleteEdge(edge.id);
        await engine.schedule(snapshot, w, fx);
      }),
  };
}
