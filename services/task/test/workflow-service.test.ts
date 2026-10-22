import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Edge,
  Node,
  NodeRun,
  Snapshot,
  Task,
  TaskStore,
  Writer,
} from '../src/repo/task-store.ts';
import { createWorkflowService } from '../src/service/workflow-service.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const STRANGER = '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d';

/** 内存版 TaskStore：同一个任务的事务排队执行，和行锁的效果一样 */
function memoryStore(): TaskStore & { runs: Map<string, NodeRun> } {
  const tasks = new Map<string, Task>();
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const runs = new Map<string, NodeRun>();
  const locks = new Map<string, Promise<unknown>>();
  const snapshot = (task: Task): Snapshot => ({
    task,
    nodes: [...nodes.values()].filter((n) => n.taskId === task.id),
    edges: [...edges.values()].filter((e) => e.taskId === task.id),
    activeRuns: [...runs.values()].filter(
      (r) => r.taskId === task.id && (r.status === 'pending' || r.status === 'running'),
    ),
  });
  return {
    runs,
    async create(input) {
      const now = new Date();
      tasks.set(input.task.id, {
        ...input.task,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        spentMicro: 0,
        attention: null,
      });
      for (const n of input.nodes) {
        nodes.set(n.id, {
          ...n,
          taskId: input.task.id,
          config: {},
          attempts: 0,
          userNotes: [],
          warning: null,
          summary: null,
          outputs: [],
          currentRunId: null,
          spentMicro: 0,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        });
      }
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
    findRun: async (runId) => runs.get(runId),
    transact(taskId, fn) {
      const previous = locks.get(taskId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const task = tasks.get(taskId);
        if (!task) throw new Error('没有任务');
        const snap = snapshot(task);
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
        };
        return fn(snap, w);
      });
      locks.set(
        taskId,
        next.catch(() => undefined),
      );
      return next;
    },
    listActiveRuns: async () =>
      [...runs.values()].filter((r) => r.status === 'pending' || r.status === 'running'),
  };
}

/** 假 harness：记下提交的运行、追问和取消；可以设置下一次提交返回 4xx 或连不上 */
const submitted: Record<string, unknown>[] = [];
const messages: { runId: string; text: string }[] = [];
const cancelled: string[] = [];
let harnessKnows = new Set<string>();
let finishedRemote = new Map<string, Record<string, unknown>>();
let rejectNext = false;
const harness = Fastify();
harness.post('/internal/runs', async (request, reply) => {
  const body = request.body as { runId: string };
  if (rejectNext) {
    rejectNext = false;
    return reply
      .code(409)
      .send({ error: { code: 'input_run_unavailable', message: '上游没了', requestId: 'r' } });
  }
  submitted.push(body as Record<string, unknown>);
  harnessKnows.add(body.runId);
  return reply.code(202).send(runBody(body.runId, 'queued'));
});
harness.get('/internal/runs/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!harnessKnows.has(id))
    return reply
      .code(404)
      .send({ error: { code: 'run_not_found', message: '无', requestId: 'r' } });
  return finishedRemote.get(id) ?? runBody(id, 'running');
});
harness.post('/internal/runs/:id/messages', async (request, reply) => {
  messages.push({
    runId: (request.params as { id: string }).id,
    text: (request.body as { text: string }).text,
  });
  return reply.code(202).send();
});
harness.post('/internal/runs/:id/cancel', async (request, reply) => {
  cancelled.push((request.params as { id: string }).id);
  return reply.code(202).send();
});
function runBody(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    payerId: OWNER,
    taskId: null,
    nodeId: null,
    model: 'm',
    status,
    error: null,
    outputs: [],
    summary: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...extra,
  };
}

let store: ReturnType<typeof memoryStore>;
let service: ReturnType<typeof createWorkflowService>;
let harnessUrl: string;
beforeAll(async () => {
  harnessUrl = await harness.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => harness.close());
beforeEach(() => {
  submitted.length = 0;
  messages.length = 0;
  cancelled.length = 0;
  harnessKnows = new Set();
  finishedRemote = new Map();
  rejectNext = false;
  store = memoryStore();
  service = createWorkflowService({
    store,
    harness: createServiceClient('harness', harnessUrl),
    maxParallel: 3,
    maxRetries: 2,
    logger: pino({ level: 'silent' }),
  });
});

const work = (key: string, title = key) => ({
  key,
  title,
  kind: 'work' as const,
  role: '',
  goal: `做 ${key}`,
  model: 'deepseek/x',
});
const create = (keys: string[], edges: [string, string][]) =>
  service.create({
    ownerId: OWNER,
    payerId: OWNER,
    title: '测试任务',
    brief: '做一份温馨小屋的介绍',
    plan: { nodes: keys.map((k) => work(k)), edges: edges.map(([from, to]) => ({ from, to })) },
  });
const runOf = (key: string, task: { nodes: { id: string; key: string }[] }) => {
  const nodeId = task.nodes.find((n) => n.key === key)?.id;
  return submitted.filter((s) => s.nodeId === nodeId).at(-1) as {
    runId: string;
    prompt: string;
    inputsFrom: { runId: string; as: string }[];
  };
};
const finish = (
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  extra: Record<string, unknown> = {},
) =>
  service.onRunFinished({
    runId,
    status,
    error: status === 'failed' ? '模型出错' : null,
    outputs: [],
    summary: null,
    ...extra,
  });
const statusOf = async (taskId: string) => {
  const task = await service.get(OWNER, taskId);
  return { task: task.status, ...Object.fromEntries(task.nodes.map((n) => [n.key, n.status])) };
};

describe('工作流调度', () => {
  it('菱形图：A、B 并行 → 都完成后 C 拿着两份上游产出开跑 → C 完成则任务完成', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'C'],
        ['B', 'C'],
      ],
    );
    expect(submitted.map((s) => s.nodeId)).toEqual(
      task.nodes.filter((n) => n.key !== 'C').map((n) => n.id),
    );
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'running', C: 'waiting' });

    await finish(runOf('A', task).runId, 'succeeded', {
      summary: 'A 写好了',
      outputs: [{ path: 'a.md', size: 3 }],
    });
    expect(submitted).toHaveLength(2); // B 还没完成，C 不跑
    await finish(runOf('B', task).runId, 'succeeded', { summary: 'B 写好了' });

    const c = runOf('C', task);
    expect(c.inputsFrom.map((i) => i.as).sort()).toEqual(['A', 'B']);
    expect(c.prompt).toContain('in/A/a.md');
    expect(c.prompt).toContain('它最后说：A 写好了');
    expect(c.prompt).toContain('做一份温馨小屋的介绍');
    await finish(c.runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ task: 'succeeded', C: 'succeeded' });
  });

  it('同一个结束事件到两次，只处理一次', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = runOf('A', task).runId;
    await finish(a, 'succeeded');
    await finish(a, 'succeeded');
    expect(submitted.filter((s) => s.nodeId === task.nodes[1]?.id)).toHaveLength(1);
  });

  it('失败自动重做 2 次；第 3 次还失败就停下等用户，下游不跑', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    await finish(runOf('A', task).runId, 'failed');
    expect(submitted).toHaveLength(3);
    await finish(runOf('A', task).runId, 'failed');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention).toMatchObject({
      reason: 'node_failed',
      message: '「A」试了 3 次都没成功',
    });
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'failed',
      attempts: 3,
    });
    expect(submitted).toHaveLength(3);
  });

  it('重做一次后成功，照常往下走', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
  });

  it('harness 明确拒绝（4xx）按运行失败处理，会自动重做', async () => {
    rejectNext = true;
    const task = await create(['A'], []);
    expect(submitted).toHaveLength(1);
    expect((await service.get(OWNER, task.id)).nodes[0]?.attempts).toBe(2);
  });
});

describe('追问与取消', () => {
  it('还没开始的节点：记下来，开跑时写进说明；运行中的：直接送到它的会话；已完成的：409', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = task.nodes.find((n) => n.key === 'A') as { id: string };
    const b = task.nodes.find((n) => n.key === 'B') as { id: string };
    expect(await service.message(OWNER, task.id, b.id, '语气活泼一点')).toBe('noted');
    expect(await service.message(OWNER, task.id, a.id, '加一句结尾')).toBe('delivered');
    expect(messages).toEqual([{ runId: runOf('A', task).runId, text: '加一句结尾' }]);

    await finish(runOf('A', task).runId, 'succeeded');
    expect(runOf('B', task).prompt).toContain('- 语气活泼一点');
    const err = await service.message(OWNER, task.id, a.id, '再改改').catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('取消：没结束的节点都取消，正在跑的通知 harness 停下；之后到的结束事件不再推进', async () => {
    const task = await create(['A', 'B', 'C'], [['A', 'C']]);
    const running = submitted.map((s) => s.runId);
    const after = await service.cancel(OWNER, task.id);
    expect(after.status).toBe('cancelled');
    expect(after.nodes.every((n) => n.status === 'cancelled')).toBe(true);
    expect(cancelled.sort()).toEqual([...running].sort());
    await finish(running[0] as string, 'cancelled');
    expect(submitted).toHaveLength(2);
  });

  it('别人的任务看不到、改不了', async () => {
    const task = await create(['A'], []);
    for (const action of [
      () => service.get(STRANGER, task.id),
      () => service.cancel(STRANGER, task.id),
      () => service.message(STRANGER, task.id, task.nodes[0]?.id ?? '', 'hi'),
    ]) {
      expect(((await action().catch((e: unknown) => e)) as HttpError).statusCode).toBe(404);
    }
    expect(await service.list(STRANGER)).toEqual([]);
  });
});

describe('对账', () => {
  it('harness 已经跑完但事件丢了：对账时补上；harness 根本没收到：重新提交同一个运行', async () => {
    const task = await create(['A', 'B'], []);
    const a = runOf('A', task).runId;
    const b = runOf('B', task).runId;
    finishedRemote.set(a, runBody(a, 'succeeded', { summary: '补上了' }));
    harnessKnows.delete(b);
    await service.reconcile(0);
    const detail = await service.get(OWNER, task.id);
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      summary: '补上了',
    });
    expect(submitted.filter((s) => s.runId === b)).toHaveLength(2);
  });
});
