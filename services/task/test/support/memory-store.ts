// 工作流测试用的内存版 TaskStore：同一个任务的事务排队执行，和行锁的效果一样；状态变化记进 events。
import type { EventEnvelope } from '@oasis/contracts/events';
import {
  deletedEvent,
  statusEvent,
  type Edge,
  type NewNode,
  type Node,
  type NodeRun,
  type Snapshot,
  type Task,
  type TaskStore,
  type WorkflowVersion,
  type Writer,
} from '../../src/repo/task-store.ts';

const newNode = (n: NewNode, taskId: string): Node => ({
  parentId: null,
  slot: null,
  ...n,
  taskId,
  attempts: 0,
  reworks: 0,
  userNotes: [],
  warning: null,
  summary: null,
  outputs: [],
  currentRunId: null,
  spentMicro: 0,
  createdAt: new Date(),
  startedAt: null,
  finishedAt: null,
  retiredVersion: null,
});

/** 发件箱里的事件 */
export const events: EventEnvelope[] = [];

/** 内存版 TaskStore：同一个任务的事务排队执行，和行锁的效果一样 */
export function memoryStore(): TaskStore & { runs: Map<string, NodeRun> } {
  const tasks = new Map<string, Task>();
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const runs = new Map<string, NodeRun>();
  const spends = new Set<string>();
  const versions: WorkflowVersion[] = [];
  const locks = new Map<string, Promise<unknown>>();
  const snapshot = (task: Task): Snapshot => ({
    task,
    nodes: [...nodes.values()].filter((n) => n.taskId === task.id && n.retiredVersion === null),
    edges: [...edges.values()].filter((e) => e.taskId === task.id),
    activeRuns: [...runs.values()].filter(
      (r) => r.taskId === task.id && (r.status === 'pending' || r.status === 'running'),
    ),
    versions: versions
      .filter((v) => v.taskId === task.id)
      .map(({ version, request, createdAt, frozenAt }) => ({
        version,
        request,
        createdAt,
        frozenAt,
      })),
  });
  return {
    runs,
    async create(input) {
      const now = new Date();
      tasks.set(input.task.id, {
        ...input.task,
        deliverables: [],
        plannerRunId: null,
        planAttempts: 0,
        acceptance: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        spentMicro: 0,
        attention: null,
        version: 1,
        revision: null,
      });
      for (const n of input.nodes) nodes.set(n.id, newNode(n, input.task.id));
      for (const e of input.edges) edges.set(e.id, { ...e, taskId: input.task.id });
    },
    async get(taskId) {
      const task = tasks.get(taskId);
      return task ? structuredClone(snapshot(task)) : undefined;
    },
    async listByOwner(ownerId) {
      return [...tasks.values()]
        .filter((t) => t.ownerId === ownerId)
        .map((task) => ({ task, nodes: snapshot(task).nodes }));
    },
    getVersion: async (taskId, version) =>
      versions.find((v) => v.taskId === taskId && v.version === version),
    findRun: async (runId) => runs.get(runId),
    listNodeRuns: async (taskId, nodeId) =>
      [...runs.values()]
        .filter((r) => r.taskId === taskId && r.nodeId === nodeId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    transact(taskId, fn) {
      const previous = locks.get(taskId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const task = tasks.get(taskId);
        if (!task) throw new Error('没有任务');
        const snap = snapshot(task);
        const before = { status: task.status, attention: task.attention };
        const w: Writer = {
          setTask: async (patch) => void Object.assign(task, patch),
          setNode: async (id, patch) => void Object.assign(nodes.get(id) as Node, patch),
          async addRun(run) {
            const row = {
              ...run,
              taskId,
              summary: null,
              error: null,
              outputs: [],
              createdAt: new Date(),
              finishedAt: null,
            };
            runs.set(run.id, row);
            snap.activeRuns.push(row);
          },
          setRun: async (id, patch) => void Object.assign(runs.get(id) as NodeRun, patch),
          async addNode(n) {
            const row = newNode(n, taskId);
            nodes.set(n.id, row);
            snap.nodes.push(row);
          },
          async deleteNode(id) {
            for (const child of snap.nodes.filter((n) => n.parentId === id))
              await w.deleteNode(child.id);
            nodes.delete(id);
            snap.nodes = snap.nodes.filter((n) => n.id !== id);
            for (const e of [...edges.values()].filter((x) => x.taskId === taskId)) {
              if (e.fromNodeId === id) e.fromNodeId = null;
              if (e.toNodeId === id) e.toNodeId = null;
              if (!e.fromNodeId && !e.toNodeId) edges.delete(e.id);
            }
            snap.edges = [...edges.values()].filter((e) => e.taskId === taskId);
          },
          async retireNode(id, version) {
            for (const child of snap.nodes.filter((n) => n.parentId === id))
              await w.retireNode(child.id, version);
            (nodes.get(id) as Node).retiredVersion = version;
            snap.nodes = snap.nodes.filter((n) => n.id !== id);
          },
          async addVersion(row) {
            const saved = { ...structuredClone(row), taskId, frozenAt: new Date() };
            versions.push(saved);
            snap.versions.push({
              version: saved.version,
              request: saved.request,
              createdAt: saved.createdAt,
              frozenAt: saved.frozenAt,
            });
          },
          async addEdge(edge) {
            const row = { ...edge, taskId };
            edges.set(edge.id, row);
            snap.edges.push(row);
          },
          setEdge: async (id, ends) => void Object.assign(edges.get(id) as Edge, ends),
          async deleteEdge(id) {
            edges.delete(id);
            snap.edges = snap.edges.filter((e) => e.id !== id);
          },
          async addSpend({ callId }) {
            if (spends.has(callId)) return false;
            spends.add(callId);
            return true;
          },
        };
        const result = await fn(snap, w);
        const event = statusEvent(before, task);
        if (event) events.push(event);
        return result;
      });
      locks.set(
        taskId,
        next.catch(() => undefined),
      );
      return next;
    },
    listActiveRuns: async () =>
      [...runs.values()].filter((r) => r.status === 'pending' || r.status === 'running'),
    findTaskByPlannerRun: async (runId) =>
      [...tasks.values()].find((t) => t.plannerRunId === runId),
    listStale: async (status) => [...tasks.values()].filter((t) => t.status === status),
    listCheckingNodes: async (before) =>
      [...nodes.values()].filter((n) => {
        const run = n.currentRunId ? runs.get(n.currentRunId) : undefined;
        return n.status === 'checking' && run?.finishedAt && run.finishedAt <= before;
      }),
    listExpanding: async (before) =>
      [...nodes.values()].filter(
        (n) =>
          n.kind === 'foreach' &&
          n.status === 'running' &&
          n.retiredVersion === null &&
          n.startedAt !== null &&
          n.startedAt <= before &&
          n.config.items === undefined,
      ),
    materialsInUse: async (ownerId, uploadIds) =>
      [...tasks.values()]
        .filter((t) => t.ownerId === ownerId)
        .flatMap((t) => t.materials.map((m) => m.uploadId))
        .filter((id, i, all) => uploadIds.includes(id) && all.indexOf(id) === i),
    async remove(taskId) {
      const task = tasks.get(taskId);
      if (!task) return undefined;
      tasks.delete(taskId);
      for (const n of [...nodes.values()].filter((x) => x.taskId === taskId)) nodes.delete(n.id);
      for (const e of [...edges.values()].filter((x) => x.taskId === taskId)) edges.delete(e.id);
      for (const r of [...runs.values()].filter((x) => x.taskId === taskId)) runs.delete(r.id);
      events.push(deletedEvent(task));
      return task;
    },
  };
}
