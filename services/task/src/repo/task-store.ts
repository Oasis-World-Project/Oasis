// 任务的数据访问。对一个任务的所有调度决定都在一个事务里做：先锁住任务这一行，
// 读出整张图，再写回改动。这样两个运行同时结束，也不会把同一个节点启动两次。
// 任务的状态或「需要处理」的原因变了，就在同一个事务里往发件箱写 task.task.status_changed。
import { TaskDeleted, TaskStatusChanged } from '@oasis/contracts/events';
import { createEnvelope } from '@oasis/service-kit';
import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import {
  edges,
  nodeRuns,
  nodes,
  outbox,
  spendRecords,
  tasks,
  workflowVersions,
  type KindConfigs,
  type NodeKind,
} from './schema.ts';

export type Task = typeof tasks.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
/** 冻结旧版的概况（快照里带着，给任务详情列出版本） */
type VersionMeta = Pick<WorkflowVersion, 'version' | 'request' | 'createdAt' | 'frozenAt'>;
/** 节点表的一行（种类和配置没有对上） */
type NodeRow = typeof nodes.$inferSelect;
/** 某种节点：配置按种类定型 */
export type NodeOf<K extends NodeKind> = Omit<NodeRow, 'kind' | 'config'> & {
  kind: K;
  config: KindConfigs[K];
};
/** 库里的节点：按 kind 区分，各带各的配置 */
export type Node = { [K in NodeKind]: NodeOf<K> }[NodeKind];
/** 库里读出来的行：种类和配置是一起写进去的，读出来照样对得上 */
const asNodes = (rows: NodeRow[]) => rows as Node[];
export type Edge = typeof edges.$inferSelect;
export type NodeRun = typeof nodeRuns.$inferSelect;

/** 一个任务的完整快照：任务本身、全部节点、连线和还没结束的运行 */
export interface Snapshot {
  task: Task;
  nodes: Node[];
  edges: Edge[];
  activeRuns: NodeRun[];
  /** 冻结的旧版（ADR 0022），按版本号排 */
  versions: VersionMeta[];
}

type TaskPatch = Partial<
  Pick<
    Task,
    | 'status'
    | 'attention'
    | 'finishedAt'
    | 'spentMicro'
    | 'budgetLimitMicro'
    | 'estimateMicro'
    | 'deliverables'
    | 'plannerRunId'
    | 'planAttempts'
    | 'acceptance'
    // 修改成果时附件并进任务素材（ADR 0012）
    | 'materials'
    // 修改交给规划员、工作流分版本（ADR 0022）
    | 'version'
    | 'revision'
  >
>;
type NewTask = Omit<
  Task,
  | 'createdAt'
  | 'updatedAt'
  | 'finishedAt'
  | 'spentMicro'
  | 'attention'
  | 'deliverables'
  | 'plannerRunId'
  | 'planAttempts'
  | 'acceptance'
  | 'version'
  | 'revision'
>;

/** 状态或「需要处理」的原因变了：要发的事件；没变返回 undefined */
export function statusEvent(before: Pick<Task, 'status' | 'attention'>, after: Task) {
  if (
    before.status === after.status &&
    JSON.stringify(before.attention) === JSON.stringify(after.attention)
  ) {
    return undefined;
  }
  return createEnvelope('task', TaskStatusChanged.type, {
    taskId: after.id,
    ownerId: after.ownerId,
    conversationId: after.conversationId,
    title: after.title,
    status: after.status,
    attention: after.attention,
    estimateMicro: after.estimateMicro,
    spentMicro: after.spentMicro,
    changedAt: new Date().toISOString(),
  });
}

/** 任务被删除时发的事件（真删除，2026-11-05） */
export function deletedEvent(task: Task) {
  return createEnvelope('task', TaskDeleted.type, {
    taskId: task.id,
    ownerId: task.ownerId,
    conversationId: task.conversationId,
    deletedAt: new Date().toISOString(),
  });
}

type NodePatch = Partial<
  Pick<
    NodeRow,
    | 'title'
    | 'role'
    | 'goal'
    | 'model'
    | 'spentMicro'
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
    // 修改方案可以给沿用旧 ID 的节点改名（ADR 0022）
    | 'key'
    // 重新展开时沿用的子节点换到新的位置（ADR 0026）
    | 'slot'
  >
>;
type RunPatch = Partial<
  Pick<NodeRun, 'status' | 'summary' | 'error' | 'outputs' | 'finishedAt' | 'meta'>
>;
export type NewNode = Pick<
  NodeRow,
  'id' | 'key' | 'title' | 'kind' | 'role' | 'goal' | 'model' | 'status' | 'config'
> &
  Partial<Pick<NodeRow, 'parentId' | 'slot'>>;
type EdgeEnds = Pick<Edge, 'fromNodeId' | 'toNodeId'>;

/** 事务里能做的写操作（写进去的同时也更新快照，后面的判断看到的是最新状态） */
export interface Writer {
  setTask(patch: TaskPatch): Promise<void>;
  setNode(nodeId: string, patch: NodePatch): Promise<void>;
  addRun(
    run: Pick<NodeRun, 'id' | 'nodeId' | 'attempt' | 'purpose' | 'status' | 'meta' | 'request'>,
  ): Promise<void>;
  setRun(runId: string, patch: RunPatch): Promise<void>;
  addNode(node: NewNode): Promise<void>;
  /** 删除节点：它的进出连线留下断开的一端；两端都空了的连线一起删掉 */
  deleteNode(nodeId: string): Promise<void>;
  /**
   * 修改方案删掉的节点：移出工作流但保留（运行记录还在，旧版能查看；ADR 0022）。
   * 它的子节点（ADR 0026）一起移出。
   */
  retireNode(nodeId: string, version: number): Promise<void>;
  addEdge(edge: Pick<Edge, 'id'> & EdgeEnds): Promise<void>;
  setEdge(edgeId: string, ends: EdgeEnds): Promise<void>;
  deleteEdge(edgeId: string): Promise<void>;
  /** 冻结一版工作流（ADR 0022） */
  addVersion(row: Omit<WorkflowVersion, 'taskId' | 'frozenAt'>): Promise<void>;
  /** 记一笔花费；这次调用已经记过时返回 false */
  addSpend(record: {
    callId: string;
    nodeId: string | null;
    chargedMicro: number;
  }): Promise<boolean>;
}

export interface TaskStore {
  create(input: {
    task: NewTask;
    nodes: NewNode[];
    edges: Pick<Edge, 'id' | 'fromNodeId' | 'toNodeId'>[];
  }): Promise<void>;
  /** 读快照（不加锁，给查询接口用） */
  get(taskId: string): Promise<Snapshot | undefined>;
  listByOwner(ownerId: string, limit: number): Promise<{ task: Task; nodes: Node[] }[]>;
  /** 冻结的某一版工作流（ADR 0022） */
  getVersion(taskId: string, version: number): Promise<WorkflowVersion | undefined>;
  findRun(runId: string): Promise<NodeRun | undefined>;
  /** 一个节点的全部运行，按开始时间排 */
  listNodeRuns(taskId: string, nodeId: string): Promise<NodeRun[]>;
  /** 锁住任务这一行，在同一个事务里读快照、做决定、写改动 */
  transact<T>(taskId: string, fn: (snapshot: Snapshot, w: Writer) => Promise<T>): Promise<T>;
  /** 还没结束、且创建早于 before 的运行（对账用） */
  listActiveRuns(before: Date): Promise<NodeRun[]>;
  /** 规划员这次运行属于哪个任务 */
  findTaskByPlannerRun(runId: string): Promise<Task | undefined>;
  /** 处在某个状态、且最近一次改动早于 before 的任务（对账卡在规划或验收的任务） */
  listStale(status: 'planning' | 'accepting', before: Date): Promise<Task[]>;
  /** 正在过关卡、且交出产出的那次运行结束早于 before 的节点（关卡中途断了，对账时重做） */
  listCheckingNodes(before: Date): Promise<Node[]>;
  /** 开始早于 before、还没展开的展开节点（读清单中途断了，对账时重读；ADR 0026） */
  listExpanding(before: Date): Promise<Node[]>;
  /** 这些上传文件里，哪些是这个人某个任务的素材（删私聊时这些文件要留着） */
  materialsInUse(ownerId: string, uploadIds: string[]): Promise<string[]>;
  /**
   * 删除任务（节点、连线、运行、花费记录级联删除），同一个事务里写 task.task.deleted。
   * 任务已经不在时返回 undefined。
   */
  remove(taskId: string): Promise<Task | undefined>;
}

async function load(db: NodePgDatabase, task: Task): Promise<Snapshot> {
  const [taskNodes, taskEdges, activeRuns, versions] = await Promise.all([
    db
      .select()
      .from(nodes)
      .where(and(eq(nodes.taskId, task.id), isNull(nodes.retiredVersion)))
      .orderBy(asc(nodes.createdAt), asc(nodes.key)),
    db.select().from(edges).where(eq(edges.taskId, task.id)),
    db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, task.id), inArray(nodeRuns.status, ['pending', 'running']))),
    db
      .select({
        version: workflowVersions.version,
        request: workflowVersions.request,
        createdAt: workflowVersions.createdAt,
        frozenAt: workflowVersions.frozenAt,
      })
      .from(workflowVersions)
      .where(eq(workflowVersions.taskId, task.id))
      .orderBy(asc(workflowVersions.version)),
  ]);
  return { task, nodes: asNodes(taskNodes), edges: taskEdges, activeRuns, versions };
}

export function createTaskStore(pool: pg.Pool): TaskStore {
  const db = drizzle(pool);
  return {
    async create(input) {
      await db.transaction(async (tx) => {
        await tx.insert(tasks).values(input.task);
        // 从任务单开始的任务还没有节点（等规划员排）
        if (input.nodes.length > 0) {
          await tx.insert(nodes).values(input.nodes.map((n) => ({ ...n, taskId: input.task.id })));
        }
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
          and(
            inArray(
              nodes.taskId,
              rows.map((t) => t.id),
            ),
            isNull(nodes.retiredVersion),
          ),
        );
      return rows.map((task) => ({
        task,
        nodes: asNodes(all.filter((n) => n.taskId === task.id)),
      }));
    },

    async getVersion(taskId, version) {
      const [row] = await db
        .select()
        .from(workflowVersions)
        .where(and(eq(workflowVersions.taskId, taskId), eq(workflowVersions.version, version)));
      return row;
    },

    async findRun(runId) {
      const [row] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId));
      return row;
    },

    listNodeRuns: (taskId, nodeId) =>
      db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
        .orderBy(asc(nodeRuns.createdAt)),

    transact(taskId, fn) {
      return db.transaction(async (tx) => {
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
        if (!task) throw new Error(`任务 ${taskId} 不存在`);
        const snapshot = await load(tx, task);
        const before = { status: task.status, attention: task.attention };
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
          async addNode(node) {
            const [row] = await tx
              .insert(nodes)
              .values({ ...node, taskId })
              .returning();
            if (row) snapshot.nodes.push(...asNodes([row]));
          },
          async deleteNode(nodeId) {
            // 连线的外键是 on delete set null：删掉节点，连线就留下断开的一端
            await tx.delete(nodes).where(eq(nodes.id, nodeId));
            await tx
              .delete(edges)
              .where(
                and(eq(edges.taskId, taskId), isNull(edges.fromNodeId), isNull(edges.toNodeId)),
              );
            // 子节点随父节点级联删除（ADR 0026）
            for (const child of snapshot.nodes.filter((n) => n.parentId === nodeId))
              await writer.deleteNode(child.id);
            snapshot.nodes = snapshot.nodes.filter((n) => n.id !== nodeId);
            for (const e of snapshot.edges) {
              if (e.fromNodeId === nodeId) e.fromNodeId = null;
              if (e.toNodeId === nodeId) e.toNodeId = null;
            }
            snapshot.edges = snapshot.edges.filter((e) => e.fromNodeId || e.toNodeId);
          },
          async retireNode(nodeId, version) {
            // 连同子节点、子节点的子节点（最多两层，ADR 0026）
            const gone = new Set([nodeId]);
            for (let grew = true; grew;) {
              grew = false;
              for (const n of snapshot.nodes)
                if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) {
                  gone.add(n.id);
                  grew = true;
                }
            }
            await tx
              .update(nodes)
              .set({ retiredVersion: version })
              .where(inArray(nodes.id, [...gone]));
            snapshot.nodes = snapshot.nodes.filter((n) => !gone.has(n.id));
          },
          async addEdge(edge) {
            const [row] = await tx
              .insert(edges)
              .values({ ...edge, taskId })
              .returning();
            if (row) snapshot.edges.push(row);
          },
          async setEdge(edgeId, ends) {
            await tx.update(edges).set(ends).where(eq(edges.id, edgeId));
            const edge = snapshot.edges.find((e) => e.id === edgeId);
            if (edge) Object.assign(edge, ends);
          },
          async deleteEdge(edgeId) {
            await tx.delete(edges).where(eq(edges.id, edgeId));
            snapshot.edges = snapshot.edges.filter((e) => e.id !== edgeId);
          },
          async addVersion(row) {
            const [saved] = await tx
              .insert(workflowVersions)
              .values({ ...row, taskId })
              .returning();
            if (saved)
              snapshot.versions.push({
                version: saved.version,
                request: saved.request,
                createdAt: saved.createdAt,
                frozenAt: saved.frozenAt,
              });
          },
          async addSpend(record) {
            const rows = await tx
              .insert(spendRecords)
              .values({ ...record, taskId })
              .onConflictDoNothing()
              .returning({ callId: spendRecords.callId });
            return rows.length > 0;
          },
        };
        const result = await fn(snapshot, writer);
        const event = statusEvent(before, snapshot.task);
        if (event) {
          await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
        }
        return result;
      });
    },

    async findTaskByPlannerRun(runId) {
      const [row] = await db.select().from(tasks).where(eq(tasks.plannerRunId, runId));
      return row;
    },

    listStale: (status, before) =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.status, status), lt(tasks.updatedAt, before))),

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
      return asNodes(rows.map((r) => r.node));
    },

    async listExpanding(before) {
      const rows = await db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.kind, 'foreach'),
            eq(nodes.status, 'running'),
            isNull(nodes.retiredVersion),
            lte(nodes.startedAt, before),
            sql`${nodes.config}->'items' is null`,
          ),
        );
      return asNodes(rows);
    },

    async materialsInUse(ownerId, uploadIds) {
      if (!uploadIds.length) return [];
      const { rows } = await pool.query<{ id: string }>(
        `select distinct m->>'uploadId' as id
           from tasks, jsonb_array_elements(tasks.materials) m
          where tasks.owner_id = $1 and m->>'uploadId' = any($2::text[])`,
        [ownerId, uploadIds],
      );
      return rows.map((r) => r.id);
    },

    remove(taskId) {
      return db.transaction(async (tx) => {
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
        if (!task) return undefined;
        await tx.delete(tasks).where(eq(tasks.id, taskId));
        const event = deletedEvent(task);
        await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
        return task;
      });
    },
  };
}
