// 任务的数据访问。对一个任务的所有调度决定都在一个事务里做：先锁住任务这一行，
// 读出整张图，再写回改动。这样两个运行同时结束，也不会把同一个节点启动两次。
import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { edges, nodeRuns, nodes, tasks } from './schema.ts';

export type Task = typeof tasks.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Edge = typeof edges.$inferSelect;
export type NodeRun = typeof nodeRuns.$inferSelect;

/** 一个任务的完整快照：任务本身、全部节点、连线和还没结束的运行 */
export interface Snapshot {
  task: Task;
  nodes: Node[];
  edges: Edge[];
  activeRuns: NodeRun[];
}

type TaskPatch = Partial<Pick<Task, 'status' | 'attention' | 'finishedAt' | 'spentMicro'>>;
type NodePatch = Partial<
  Pick<
    Node,
    | 'status'
    | 'attempts'
    | 'reworks'
    | 'config'
    | 'userNotes'
    | 'warning'
    | 'summary'
    | 'outputs'
    | 'currentRunId'
    | 'startedAt'
    | 'finishedAt'
  >
>;
type RunPatch = Partial<Pick<NodeRun, 'status' | 'summary' | 'error' | 'outputs' | 'finishedAt'>>;

/** 事务里能做的写操作（写进去的同时也更新快照，后面的判断看到的是最新状态） */
export interface Writer {
  setTask(patch: TaskPatch): Promise<void>;
  setNode(nodeId: string, patch: NodePatch): Promise<void>;
  addRun(
    run: Pick<NodeRun, 'id' | 'nodeId' | 'attempt' | 'purpose' | 'status' | 'meta' | 'request'>,
  ): Promise<void>;
  setRun(runId: string, patch: RunPatch): Promise<void>;
}

export interface TaskStore {
  create(input: {
    task: Omit<Task, 'createdAt' | 'updatedAt' | 'finishedAt' | 'spentMicro' | 'attention'>;
    nodes: Pick<
      Node,
      'id' | 'key' | 'title' | 'kind' | 'role' | 'goal' | 'model' | 'status' | 'config'
    >[];
    edges: Pick<Edge, 'id' | 'fromNodeId' | 'toNodeId'>[];
  }): Promise<void>;
  /** 读快照（不加锁，给查询接口用） */
  get(taskId: string): Promise<Snapshot | undefined>;
  listByOwner(ownerId: string, limit: number): Promise<{ task: Task; nodes: Node[] }[]>;
  findRun(runId: string): Promise<NodeRun | undefined>;
  /** 锁住任务这一行，在同一个事务里读快照、做决定、写改动 */
  transact<T>(taskId: string, fn: (snapshot: Snapshot, w: Writer) => Promise<T>): Promise<T>;
  /** 还没结束、且创建早于 before 的运行（对账用） */
  listActiveRuns(before: Date): Promise<NodeRun[]>;
  /** 正在过关卡、且交出产出的那次运行结束早于 before 的节点（关卡中途断了，对账时重做） */
  listCheckingNodes(before: Date): Promise<Node[]>;
}

async function load(db: NodePgDatabase, task: Task): Promise<Snapshot> {
  const [taskNodes, taskEdges, activeRuns] = await Promise.all([
    db
      .select()
      .from(nodes)
      .where(eq(nodes.taskId, task.id))
      .orderBy(asc(nodes.createdAt), asc(nodes.key)),
    db.select().from(edges).where(eq(edges.taskId, task.id)),
    db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, task.id), inArray(nodeRuns.status, ['pending', 'running']))),
  ]);
  return { task, nodes: taskNodes, edges: taskEdges, activeRuns };
}

export function createTaskStore(pool: pg.Pool): TaskStore {
  const db = drizzle(pool);
  return {
    async create(input) {
      await db.transaction(async (tx) => {
        await tx.insert(tasks).values(input.task);
        await tx.insert(nodes).values(input.nodes.map((n) => ({ ...n, taskId: input.task.id })));
        if (input.edges.length > 0) {
          await tx.insert(edges).values(input.edges.map((e) => ({ ...e, taskId: input.task.id })));
        }
      });
    },

    async get(taskId) {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      return task ? load(db, task) : undefined;
    },

    async listByOwner(ownerId, limit) {
      const rows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.ownerId, ownerId))
        .orderBy(desc(tasks.createdAt))
        .limit(limit);
      if (rows.length === 0) return [];
      const all = await db
        .select()
        .from(nodes)
        .where(
          inArray(
            nodes.taskId,
            rows.map((t) => t.id),
          ),
        );
      return rows.map((task) => ({ task, nodes: all.filter((n) => n.taskId === task.id) }));
    },

    async findRun(runId) {
      const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId));
      return row;
    },

    transact(taskId, fn) {
      return db.transaction(async (tx) => {
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
        if (!task) throw new Error(`任务 ${taskId} 不存在`);
        const snapshot = await load(tx, task);
        const writer: Writer = {
          async setTask(patch) {
            await tx
              .update(tasks)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(tasks.id, taskId));
            Object.assign(snapshot.task, patch);
          },
          async setNode(nodeId, patch) {
            await tx.update(nodes).set(patch).where(eq(nodes.id, nodeId));
            const node = snapshot.nodes.find((n) => n.id === nodeId);
            if (node) Object.assign(node, patch);
          },
          async addRun(run) {
            const [row] = await tx
              .insert(nodeRuns)
              .values({ ...run, taskId })
              .returning();
            if (row) snapshot.activeRuns.push(row);
          },
          async setRun(runId, patch) {
            await tx.update(nodeRuns).set(patch).where(eq(nodeRuns.id, runId));
            const run = snapshot.activeRuns.find((r) => r.id === runId);
            if (run) Object.assign(run, patch);
          },
        };
        return fn(snapshot, writer);
      });
    },

    listActiveRuns: (before) =>
      db
        .select()
        .from(nodeRuns)
        .where(
          and(inArray(nodeRuns.status, ['pending', 'running']), lt(nodeRuns.createdAt, before)),
        ),

    async listCheckingNodes(before) {
      const rows = await db
        .select({ node: nodes })
        .from(nodes)
        .innerJoin(nodeRuns, eq(nodeRuns.id, nodes.currentRunId))
        .where(and(eq(nodes.status, 'checking'), lte(nodeRuns.finishedAt, before)));
      return rows.map((r) => r.node);
    },
  };
}
