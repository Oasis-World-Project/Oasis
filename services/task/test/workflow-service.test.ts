import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@oasis/contracts/events';
import {
  statusEvent,
  type Edge,
  type NewNode,
  type Node,
  type NodeRun,
  type Snapshot,
  type Task,
  type TaskStore,
  type Writer,
} from '../src/repo/task-store.ts';
import type { Gate } from '../src/service/gate.ts';
import { createWorkflowService } from '../src/service/workflow-service.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const STRANGER = '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d';

const newNode = (n: NewNode, taskId: string): Node => ({
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
});

/** 内存版 TaskStore：同一个任务的事务排队执行，和行锁的效果一样 */
/** 发件箱里的事件 */
const events: EventEnvelope[] = [];

function memoryStore(): TaskStore & { runs: Map<string, NodeRun> } {
  const tasks = new Map<string, Task>();
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const runs = new Map<string, NodeRun>();
  const spends = new Set<string>();
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
        deliverables: [],
        plannerRunId: null,
        planAttempts: 0,
        acceptance: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        spentMicro: 0,
        attention: null,
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
    findRun: async (runId) => runs.get(runId),
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
            nodes.delete(id);
            snap.nodes = snap.nodes.filter((n) => n.id !== id);
            for (const e of [...edges.values()].filter((x) => x.taskId === taskId)) {
              if (e.fromNodeId === id) e.fromNodeId = null;
              if (e.toNodeId === id) e.toNodeId = null;
              if (!e.fromNodeId && !e.toNodeId) edges.delete(e.id);
            }
            snap.edges = [...edges.values()].filter((e) => e.taskId === taskId);
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
  };
}

/** 假 harness：记下提交的运行、追问、停止和取消；可以设置下一次提交返回 4xx 或连不上 */
const submitted: Record<string, unknown>[] = [];
const messages: { runId: string; text: string }[] = [];
const cancelled: string[] = [];
const stopped: string[] = [];
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
/** 规划员写的方案：运行 ID → plan.json 的内容 */
let plans = new Map<string, string>();
harness.get('/internal/runs/:id/files/*', async (request, reply) => {
  const { id } = request.params as { id: string };
  const plan = plans.get(id);
  if (!plan)
    return reply
      .code(404)
      .send({ error: { code: 'file_not_found', message: '无', requestId: 'r' } });
  return reply.type('application/json').send(plan);
});
/** 假 agent：模型目录 */
harness.get('/internal/models/catalog', async () => ({
  models: [
    {
      key: 'deepseek',
      name: 'DeepSeek',
      vendor: '深度求索',
      category: 'llm',
      tags: ['性价比'],
      providerModel: 'deepseek/x',
    },
    {
      key: 'gpt',
      name: 'GPT',
      vendor: 'OpenAI',
      category: 'llm',
      tags: ['通用'],
      providerModel: 'openai/blocked',
    },
  ],
}));
/** 假 model-gateway：在当前网络用不了的模型 */
let unavailable: string[] = [];
harness.get('/internal/v1/models/unavailable', async () => ({ models: unavailable }));
harness.post('/internal/runs/:id/messages', async (request, reply) => {
  messages.push({
    runId: (request.params as { id: string }).id,
    text: (request.body as { text: string }).text,
  });
  return reply.code(202).send();
});
harness.post('/internal/runs/:id/stop', async (request, reply) => {
  stopped.push((request.params as { id: string }).id);
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

/** 假关卡：按顺序返回预设的结果（默认通过）；设成 'throw' 时这一次检查出错 */
let gateResults: (string[] | 'throw')[] = [];
const gateCalls: { runId: string; checks: string[] }[] = [];
const gate = {
  async check(input: { runs: { runId: string }[]; checks: string[] }) {
    gateCalls.push({ runId: input.runs[0]?.runId ?? '', checks: input.checks });
    const next = gateResults.shift() ?? [];
    if (next === 'throw') throw new Error('关卡断了');
    return { unmet: next };
  },
};

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
  stopped.length = 0;
  harnessKnows = new Set();
  finishedRemote = new Map();
  rejectNext = false;
  plans = new Map();
  unavailable = [];
  events.length = 0;
  gateResults = [];
  gateCalls.length = 0;
  store = memoryStore();
  service = createWorkflowService({
    store,
    harness: createServiceClient('harness', harnessUrl),
    gate: gate as unknown as Gate,
    maxParallel: 3,
    maxRetries: 2,
    maxReworks: 1,
    budgetMultiplier: 3,
    agent: createServiceClient('agent', harnessUrl),
    modelGateway: createServiceClient('model-gateway', harnessUrl),
    planning: {
      model: 'deepseek/planner',
      defaultModel: 'deepseek/x',
      maxNodes: 4,
      maxAttempts: 2,
      rates: { workRun: 3_000, speechRun: 3_000 },
    },
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
  checks: [] as string[],
  expects: [] as string[],
});
const discussion = (key: string, names: string[], rounds = 2) => ({
  key,
  title: key,
  kind: 'discussion' as const,
  role: '',
  goal: '定下小屋介绍的风格',
  model: 'deepseek/summary',
  checks: ['给出明确建议'],
  expects: [] as string[],
  participants: names.map((name) => ({ name, model: `deepseek/${name}`, stance: `${name}的立场` })),
  rounds,
});
type PlanNode = ReturnType<typeof work> | ReturnType<typeof discussion>;
const create = (keys: (string | PlanNode)[], edges: [string, string][], estimateMicro?: number) =>
  service.create({
    ownerId: OWNER,
    payerId: OWNER,
    title: '测试任务',
    brief: '做一份温馨小屋的介绍',
    ...(estimateMicro ? { estimateMicro } : {}),
    plan: {
      nodes: keys.map((k) => (typeof k === 'string' ? work(k) : k)),
      edges: edges.map(([from, to]) => ({ from, to })),
    },
  });
interface Submitted {
  runId: string;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  continueFrom?: string;
}
const runsOf = (key: string, task: { nodes: { id: string; key: string }[] }) => {
  const nodeId = task.nodes.find((n) => n.key === key)?.id;
  return submitted.filter((s) => s.nodeId === nodeId) as unknown as Submitted[];
};
const runOf = (key: string, task: { nodes: { id: string; key: string }[] }) =>
  runsOf(key, task).at(-1) as Submitted;
const finish = (
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled' | 'stopped',
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
    await finish(runOf('B', task).runId, 'succeeded', {
      summary: 'B 写好了',
      outputs: [{ path: 'b.md', size: 3 }],
    });

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

describe('出口关卡', () => {
  it('没过：接着原会话改一次（带上没满足的地方）→ 再检查通过才算完成，下游才跑', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const first = runOf('A', task);
    gateResults = [['缺少文件 out/*.md']];
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'a.txt', size: 3 }] });

    const rework = runOf('A', task);
    expect(rework.runId).not.toBe(first.runId);
    expect(rework.continueFrom).toBe(first.runId);
    expect(rework.prompt).toContain('- 缺少文件 out/*.md');
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });

    await finish(rework.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 3 }] });
    expect(gateCalls.map((c) => c.runId)).toEqual([first.runId, rework.runId]);
    const detail = await service.get(OWNER, task.id);
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      reworks: 1,
      warning: null,
      outputs: [{ path: 'a.md', size: 3 }],
    });
    // 下游拿到的是改过的那次运行的产出
    expect(runOf('B', task).inputsFrom).toEqual([{ runId: rework.runId, as: 'A' }]);
  });

  it('改过一次还没过：照样往下走，只在节点上留提醒', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    gateResults = [['语气不够友好'], ['语气不够友好']];
    await finish(runOf('A', task).runId, 'succeeded');
    await finish(runOf('A', task).runId, 'succeeded');
    const detail = await service.get(OWNER, task.id);
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      warning: '交付前检查没完全通过：语气不够友好',
    });
    expect(await statusOf(task.id)).toMatchObject({ B: 'running' });
  });

  it('关卡检查中途断了：节点停在检查中，对账时重新检查', async () => {
    const task = await create(['A'], []);
    gateResults = ['throw'];
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'checking' });
    await service.reconcile(0);
    expect(await statusOf(task.id)).toMatchObject({ task: 'succeeded', A: 'succeeded' });
  });

  it('正在过关卡的节点不能追问', async () => {
    const task = await create(['A'], []);
    gateResults = ['throw'];
    await finish(runOf('A', task).runId, 'succeeded');
    const err = await service
      .message(OWNER, task.id, task.nodes[0]?.id ?? '', '再改改')
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });
});

describe('讨论节点', () => {
  it('每轮所有人并行发言 → 下一轮接着自己的会话回应别人 → 汇总者写结论 → 过关卡', async () => {
    const task = await create([discussion('D', ['甲', '乙']), 'W'], [['D', 'W']]);
    const round1 = runsOf('D', task);
    expect(round1.map((r) => r.model)).toEqual(['deepseek/甲', 'deepseek/乙']);
    expect(round1[0]?.prompt).toContain('你是「甲」');
    expect(round1[0]?.prompt).toContain('甲的立场');
    expect(round1[0]?.prompt).toContain('第 1 轮（共 2 轮）');

    await finish(round1[0]?.runId as string, 'succeeded', { summary: '我觉得要温馨' });
    expect(runsOf('D', task)).toHaveLength(2); // 乙还没说完，不开下一轮
    await finish(round1[1]?.runId as string, 'succeeded', { summary: '我觉得要简洁' });

    const round2 = runsOf('D', task).slice(2);
    expect(round2).toHaveLength(2);
    expect(round2[0]?.continueFrom).toBe(round1[0]?.runId);
    expect(round2[0]?.prompt).toContain('第 1 轮 乙：我觉得要简洁');
    expect(round2[0]?.prompt).not.toContain('我觉得要温馨');
    expect(round2[1]?.continueFrom).toBe(round1[1]?.runId);

    await finish(round2[0]?.runId as string, 'succeeded', { summary: '可以兼顾' });
    await finish(round2[1]?.runId as string, 'succeeded', { summary: '同意兼顾' });
    const summary = runOf('D', task);
    expect(summary.model).toBe('deepseek/summary');
    expect(summary.prompt).toContain('第 2 轮 甲：可以兼顾');
    expect(summary.prompt).toContain('第 1 轮 乙：我觉得要简洁');

    await finish(summary.runId, 'succeeded', { outputs: [{ path: '讨论结论.md', size: 10 }] });
    expect(gateCalls).toEqual([{ runId: summary.runId, checks: ['给出明确建议'] }]);
    const detail = await service.get(OWNER, task.id);
    const d = detail.nodes.find((n) => n.key === 'D');
    expect(d?.status).toBe('succeeded');
    expect(d?.discussion).toMatchObject({ rounds: 2, round: 2 });
    expect(d?.discussion?.transcript).toHaveLength(4);
    expect(runOf('W', task).inputsFrom).toEqual([{ runId: summary.runId, as: 'D' }]);
  });

  it('讨论进行中追问：记下来，下一轮发言带上', async () => {
    const task = await create([discussion('D', ['甲', '乙'])], []);
    const d = task.nodes[0]?.id ?? '';
    expect(await service.message(OWNER, task.id, d, '别超过 100 字')).toBe('noted');
    for (const r of runsOf('D', task)) await finish(r.runId, 'succeeded', { summary: '好' });
    expect(runOf('D', task).prompt).toContain('【用户新追加的要求】\n- 别超过 100 字');
  });

  it('某人发言失败只重做他这一句；重做用完还失败，停掉同一轮其他人的发言', async () => {
    const task = await create([discussion('D', ['甲', '乙'], 1)], []);
    const [jia, yi] = runsOf('D', task);
    await finish(jia?.runId as string, 'failed');
    const retry = runOf('D', task);
    expect(retry.model).toBe('deepseek/甲');
    expect(retry.prompt).toContain('你是「甲」');
    await finish(retry.runId, 'failed');
    await finish(runOf('D', task).runId, 'failed');
    expect(await statusOf(task.id)).toMatchObject({ task: 'needs_attention', D: 'failed' });
    expect(cancelled).toEqual([yi?.runId]);
  });
});

const keyOf = (task: { nodes: { id: string; key: string }[] }, key: string) =>
  task.nodes.find((n) => n.key === key)?.id as string;
const errorOf = async (action: () => Promise<unknown>) => {
  const err = (await action().catch((e: unknown) => e)) as HttpError;
  return { status: err.statusCode, message: err.message };
};

describe('停止与继续', () => {
  it('停止整个任务：在跑的节点停下（harness 存下产出和会话）；停下时追问记下来；点运行接着原会话做', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = runOf('A', task);
    const after = await service.stop(OWNER, task.id);
    expect(after.status).toBe('stopped');
    expect(after.nodes.find((n) => n.key === 'A')?.status).toBe('stopped');
    expect(stopped).toEqual([a.runId]);
    await finish(a.runId, 'stopped'); // harness 停好了：不再推进
    expect(await service.message(OWNER, task.id, keyOf(task, 'A'), '结尾加一句')).toBe('noted');

    expect((await service.run(OWNER, task.id)).status).toBe('running');
    const resumed = runOf('A', task);
    expect(resumed.continueFrom).toBe(a.runId);
    expect(resumed.prompt).toContain('你刚才被用户停下了');
    expect(resumed.prompt).toContain('- 结尾加一句');
    await finish(resumed.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
  });

  it('停止一个节点：其他支路照常跑；都跑不动了任务停下；单独运行它只跑它，不自动往下', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'C'],
        ['B', 'C'],
      ],
    );
    await service.stopNode(OWNER, task.id, keyOf(task, 'A'));
    await finish(runOf('B', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'stopped',
      A: 'stopped',
      B: 'succeeded',
    });

    await service.runNode(OWNER, task.id, keyOf(task, 'A'));
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'stopped',
      A: 'succeeded',
      C: 'waiting',
    });
    expect(runsOf('C', task)).toHaveLength(0);

    await service.run(OWNER, task.id);
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', C: 'running' });
  });

  it('讨论说到一半停下：继续时只让没说完的人重新说这一轮', async () => {
    const task = await create([discussion('D', ['甲', '乙'])], []);
    const [jia, yi] = runsOf('D', task);
    await finish(jia?.runId as string, 'succeeded', { summary: '甲的看法' });
    await service.stop(OWNER, task.id);
    expect(stopped).toEqual([yi?.runId]);
    await service.run(OWNER, task.id);
    const again = runsOf('D', task).slice(2);
    expect(again).toHaveLength(1);
    expect(again[0]?.model).toBe('deepseek/乙');
    expect(again[0]?.prompt).toContain('第 1 轮');
  });

  it('不在跑的节点不能停；已完成的节点不能再运行', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    expect((await errorOf(() => service.stopNode(OWNER, task.id, keyOf(task, 'B')))).status).toBe(
      409,
    );
    await finish(runOf('A', task).runId, 'succeeded');
    expect((await errorOf(() => service.runNode(OWNER, task.id, keyOf(task, 'A')))).status).toBe(
      409,
    );
  });
});

describe('编辑节点和连线', () => {
  it('删掉中间节点留下断口 → 整体运行报错列出问题 → 新建节点接上线头 → 运行后新节点拿到上游产出', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['B', 'C'],
      ],
    );
    let detail = await service.deleteNode(OWNER, task.id, keyOf(task, 'B'));
    const tail = detail.edges.find((e) => e.to === null) as { id: string };
    const head = detail.edges.find((e) => e.from === null) as { id: string };
    expect(detail.nodes.find((n) => n.key === 'C')?.status).toBe('blocked');

    const invalid = await errorOf(() => service.run(OWNER, task.id));
    expect(invalid.status).toBe(409);
    expect(invalid.message).toContain('「C」前面的连线没接上');
    expect(invalid.message).toContain('「A」后面的连线没接上');

    detail = await service.createNode(OWNER, task.id, work('N', '新步骤'));
    const n = keyOf(detail, 'N');
    expect(detail.nodes.find((x) => x.key === 'N')?.status).toBe('draft');
    await service.updateEdge(OWNER, task.id, tail.id, { to: n });
    detail = await service.updateEdge(OWNER, task.id, head.id, { from: n });
    expect(detail.nodes.find((x) => x.key === 'C')?.status).toBe('waiting');

    // A 做完：新建的节点不会自己开跑，任务停下等用户点运行
    await finish(runOf('A', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    expect(await statusOf(task.id)).toMatchObject({ task: 'stopped', N: 'draft', C: 'waiting' });
    await service.run(OWNER, task.id);
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', N: 'running' });
    expect(runOf('N', detail).inputsFrom.map((i) => i.as)).toEqual(['A']);
  });

  it('改还没开始的节点会用在它的说明里；已经开始的不能改、不能删、不能往里接线；不能成环', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await service.updateNode(OWNER, task.id, keyOf(task, 'B'), { goal: '写成一首诗' });
    for (const action of [
      () => service.updateNode(OWNER, task.id, keyOf(task, 'A'), { goal: '改' }),
      () => service.deleteNode(OWNER, task.id, keyOf(task, 'A')),
      () => service.createEdge(OWNER, task.id, keyOf(task, 'B'), keyOf(task, 'A')),
    ]) {
      expect((await errorOf(action)).status).toBe(409);
    }
    const c = keyOf(await service.createNode(OWNER, task.id, work('C')), 'C');
    await service.createEdge(OWNER, task.id, keyOf(task, 'B'), c);
    const cycle = await errorOf(() => service.createEdge(OWNER, task.id, c, keyOf(task, 'B')));
    expect(cycle).toMatchObject({ status: 409, message: '连上之后工作流会成环' });
    expect((await errorOf(() => service.updateNode(OWNER, task.id, c, { rounds: 3 }))).status).toBe(
      400,
    );

    await finish(runOf('A', task).runId, 'succeeded');
    expect(runOf('B', task).prompt).toContain('写成一首诗');
  });

  it('任务结束后不能再改', async () => {
    const task = await create(['A'], []);
    await service.cancel(OWNER, task.id);
    const err = await errorOf(() => service.createNode(OWNER, task.id, work('X')));
    expect(err).toMatchObject({ status: 409 });
  });
});

describe('需要处理时三选一', () => {
  const failThrice = async (task: { nodes: { id: string; key: string }[] }, key: string) => {
    for (let i = 0; i < 3; i++) await finish(runOf(key, task).runId, 'failed');
  };

  it('节点失败 → 用现在的结果继续：它算完成并留提醒，下游照常跑（拿不到它的产出）', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await failThrice(task, 'A');
    const detail = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(detail.status).toBe('running');
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      warning: '没能完成，按你的选择用现有的结果继续往下做',
    });
    expect(runOf('B', task).inputsFrom).toEqual([]);
  });

  it('节点失败 → 再试：重做次数重新算', async () => {
    const task = await create(['A'], []);
    await failThrice(task, 'A');
    await service.decide(OWNER, task.id, { choice: 'retry' });
    expect((await service.get(OWNER, task.id)).nodes[0]).toMatchObject({
      status: 'running',
      attempts: 1,
    });
    expect(submitted).toHaveLength(4);
  });

  it('连线断开时只能接线或取消；不需要处理时不能选', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['B', 'C'],
      ],
    );
    expect(
      (await errorOf(() => service.decide(OWNER, task.id, { choice: 'continue' }))).status,
    ).toBe(409);
    await service.deleteNode(OWNER, task.id, keyOf(task, 'B'));
    await finish(runOf('A', task).runId, 'succeeded');
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'workflow_broken', message: '「C」前面的连线断开了' },
    });
    expect(await errorOf(() => service.decide(OWNER, task.id, { choice: 'retry' }))).toMatchObject({
      status: 409,
      message: '工作流的连线断开了：先把线接好再点运行，或者取消任务',
    });
    expect((await service.decide(OWNER, task.id, { choice: 'cancel' })).status).toBe('cancelled');
  });
});

describe('花费', () => {
  const settle = (taskId: string, nodeId: string, callId: string, chargedMicro: number) =>
    service.onCallSettled({ callId, taskId, nodeId, chargedMicro });
  const CALL = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it('结算事件累加到任务和节点（同一次调用只算一次）；超过预估 3 倍就停下所有节点问用户', async () => {
    const task = await create(['A', 'B'], [], 1_000);
    expect(task.budgetLimitMicro).toBe(3_000);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    let detail = await service.get(OWNER, task.id);
    expect(detail.spentMicro).toBe(2_000);
    expect(detail.nodes.find((n) => n.key === 'A')?.spentMicro).toBe(2_000);

    await settle(task.id, keyOf(task, 'B'), CALL(2), 1_500);
    detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention).toMatchObject({
      reason: 'over_budget',
      message: '已经花了 $0.0035，超过了预估（$0.001）的 3 倍',
    });
    expect(detail.nodes.map((n) => n.status)).toEqual(['stopped', 'stopped']);
    expect(stopped.sort()).toEqual([runOf('A', task).runId, runOf('B', task).runId].sort());

    expect((await errorOf(() => service.decide(OWNER, task.id, { choice: 'retry' }))).status).toBe(
      409,
    );
    detail = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(detail).toMatchObject({ status: 'running', budgetLimitMicro: 6_500 });
    expect(runOf('A', task).continueFrom).toBeDefined();
  });
});

describe('规划（从任务单开始）', () => {
  const sheetOf = (budgetMicro: number | null = null) => ({
    title: '小木屋首页',
    deliverables: [{ name: '首页文案', form: 'Markdown' }],
    criteria: ['语气温馨'],
    style: [],
    budgetMicro,
    assumptions: [],
    materials: [],
  });
  const fromSheet = (budgetMicro: number | null = null) =>
    service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: sheetOf(budgetMicro),
    });
  const plannerRuns = () =>
    submitted.filter((s) => !s.nodeId) as unknown as {
      runId: string;
      model: string;
      prompt: string;
      continueFrom?: string;
    }[];
  const goodPlan = JSON.stringify({
    nodes: [work('write', '写初稿'), work('polish', '润色')],
    edges: [{ from: 'write', to: 'polish' }],
    deliverables: { 首页文案: 'polish' },
  });
  const plannerDone = async (
    plan: string | undefined,
    status: 'succeeded' | 'failed' = 'succeeded',
  ) => {
    const run = plannerRuns().at(-1)!;
    if (plan) plans.set(run.runId, plan);
    await finish(run.runId, status);
    return run;
  };

  it('建任务后先规划；方案过了规划门就建节点、算预估和上限、开跑，并发出状态事件', async () => {
    const task = await fromSheet();
    expect(task).toMatchObject({ status: 'planning', nodes: [], sheet: { title: '小木屋首页' } });
    const [planner] = plannerRuns();
    expect(planner?.model).toBe('deepseek/planner');
    expect(planner?.prompt).toContain('「首页文案」');
    expect(planner?.prompt).toContain('deepseek/x（DeepSeek');
    expect(planner?.prompt).toContain('最多 4 个节点');

    await plannerDone(goodPlan);
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({
      status: 'running',
      estimateMicro: 7_200,
      budgetLimitMicro: 21_600,
    });
    expect(detail.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'write=running',
      'polish=waiting',
    ]);
    expect(detail.deliverables).toEqual([
      { name: '首页文案', form: 'Markdown', nodeId: keyOf(detail, 'polish') },
    ]);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['running']);
  });

  it('方案没过规划门：接着原会话让规划员改；改好了照常开跑', async () => {
    const task = await fromSheet();
    const bad = JSON.stringify({
      nodes: [{ ...work('write'), model: 'openai/unknown' }],
      edges: [],
      deliverables: {},
    });
    const first = await plannerDone(bad);
    const revise = plannerRuns().at(-1)!;
    expect(revise.continueFrom).toBe(first.runId);
    expect(revise.prompt).toContain('模型 openai/unknown 不在可以用的模型里');
    expect(revise.prompt).toContain('交付物「首页文案」没有指定由哪个节点交出');
    await plannerDone(goodPlan);
    expect((await service.get(OWNER, task.id)).status).toBe('running');
  });

  it('规划员自己失败了：从头再排；两次都不行就交给用户（重新规划 / 取消）', async () => {
    const task = await fromSheet();
    await plannerDone(undefined, 'failed');
    expect(plannerRuns().at(-1)!.continueFrom).toBeUndefined();
    await plannerDone('不是 JSON');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention?.reason).toBe('plan_failed');
    expect(detail.attention?.message).toContain('不是合法的 JSON');
    expect(
      (await errorOf(() => service.decide(OWNER, task.id, { choice: 'continue' }))).status,
    ).toBe(409);

    expect((await service.decide(OWNER, task.id, { choice: 'retry' })).status).toBe('planning');
    expect(plannerRuns()).toHaveLength(3);
    await plannerDone(goodPlan);
    expect((await service.get(OWNER, task.id)).status).toBe('running');
  });

  it('预估超过用户在任务单里设的上限：先不开跑，问用户；照做就按预估定上限开跑', async () => {
    const task = await fromSheet(1_000);
    await plannerDone(goodPlan);
    let detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'over_estimate', message: '预计要花 $0.0072，超过了你设的上限 $0.001' },
    });
    expect(detail.nodes.every((n) => n.status === 'waiting')).toBe(true);
    detail = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(detail).toMatchObject({ status: 'running', budgetLimitMicro: 21_600 });
    expect(detail.nodes.find((n) => n.key === 'write')?.status).toBe('running');
  });

  it('规划中不能改工作流；取消会停掉规划员', async () => {
    const task = await fromSheet();
    expect(await errorOf(() => service.createNode(OWNER, task.id, work('x')))).toMatchObject({
      status: 409,
      message: 'AI 团队还在搭建工作流，请稍等',
    });
    await service.cancel(OWNER, task.id);
    expect(cancelled).toEqual([plannerRuns()[0]?.runId]);
    await plannerDone(goodPlan); // 取消后才到的结束事件不再推进
    expect((await service.get(OWNER, task.id)).nodes).toEqual([]);
  });
});

describe('下载成果', () => {
  it('转给 harness 读交出这份产出的那次运行；节点没有这个文件就 404', async () => {
    const task = await create(['A'], []);
    const run = runOf('A', task);
    plans.set(run.runId, '# 小木屋');
    await finish(run.runId, 'succeeded', { outputs: [{ path: '首页.md', size: 11 }] });
    const file = await service.file(OWNER, task.id, keyOf(task, 'A'), '首页.md');
    expect(file.content.toString()).toBe('# 小木屋');
    expect(
      (await errorOf(() => service.file(OWNER, task.id, keyOf(task, 'A'), '别的.md'))).status,
    ).toBe(404);
  });
});

describe('整体验收（从任务单来的任务）', () => {
  const start = async (criteria = ['语气温馨', '不超过 80 字']) => {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: {
        title: '小木屋首页',
        deliverables: [
          { name: '首页文案', form: 'Markdown' },
          { name: '海报文案', form: 'Markdown' },
        ],
        criteria,
        style: [],
        budgetMicro: null,
        assumptions: [],
        materials: [],
      },
    });
    const planner = submitted.find((s) => !s.nodeId) as { runId: string };
    plans.set(
      planner.runId,
      JSON.stringify({
        nodes: [work('home'), work('poster')],
        edges: [],
        deliverables: { 首页文案: 'home', 海报文案: 'poster' },
      }),
    );
    await finish(planner.runId, 'succeeded');
    return service.get(OWNER, task.id);
  };

  it('工作流跑完先验收：负责交付物的节点交出的东西一起看；没满足的记下来，照样完成', async () => {
    const task = await start();
    gateResults = [[], [], ['不超过 80 字']]; // 两个节点各自的关卡通过；整体验收有一条没满足
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: '海报.md', size: 9 }],
    });
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'succeeded', acceptance: { unmet: ['不超过 80 字'] } });
    expect(gateCalls.at(-1)).toEqual({
      runId: runOf('home', task).runId,
      checks: ['语气温馨', '不超过 80 字'],
    });
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'running',
      'accepting',
      'succeeded',
    ]);
  });

  it('负责交付物的节点没交出文件：直接记为没满足（跳过它时就是这样）', async () => {
    const task = await start();
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    for (let i = 0; i < 3; i++) await finish(runOf('poster', task).runId, 'failed');
    await service.decide(OWNER, task.id, { choice: 'continue' });
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('succeeded');
    expect(detail.acceptance?.unmet).toEqual(['「海报文案」没有交出文件']);
  });

  it('验收中途断了：任务停在验收中，对账时重新验收', async () => {
    const task = await start();
    gateResults = [[], [], 'throw'];
    await finish(runOf('home', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: 'b.md', size: 1 }],
    });
    expect((await service.get(OWNER, task.id)).status).toBe('accepting');
    await service.reconcile(0);
    expect(await service.get(OWNER, task.id)).toMatchObject({
      status: 'succeeded',
      acceptance: { unmet: [] },
    });
  });
});

describe('模型在当前网络用不了', () => {
  const REGION =
    '502: {"code":"provider_region_unavailable","message":"这个模型在当前网络所在的地区用不了"}';

  it('规划员的模型目录里去掉用不了的模型', async () => {
    unavailable = ['openai/blocked'];
    await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: 't',
      brief: 'b',
      sheet: {
        title: 't',
        deliverables: [{ name: 'd', form: 'f' }],
        criteria: ['c'],
        style: [],
        budgetMicro: null,
        assumptions: [],
        materials: [],
      },
    });
    const prompt = (submitted.find((x) => !x.nodeId) as { prompt: string }).prompt;
    expect(prompt).toContain('deepseek/x（DeepSeek');
    expect(prompt).not.toContain('openai/blocked');
  });

  it('干活节点碰上了：换默认模型接着做，不算一次重做，节点上留提醒', async () => {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: 't',
      brief: 'b',
      plan: { nodes: [{ ...work('A'), model: 'openai/blocked' }], edges: [] },
    });
    await finish(runOf('A', task).runId, 'failed', { error: REGION });
    const next = runOf('A', task);
    expect(next.model).toBe('deepseek/x');
    const node = (await service.get(OWNER, task.id)).nodes[0];
    expect(node).toMatchObject({
      status: 'running',
      model: 'deepseek/x',
      attempts: 1,
      warning: '原定的模型 openai/blocked 在当前网络用不了，改用 deepseek/x',
    });
    // 默认模型也用不了：照常按失败重做
    await finish(next.runId, 'failed', { error: REGION });
    expect((await service.get(OWNER, task.id)).nodes[0]?.attempts).toBe(2);
  });

  it('讨论里某位参与者碰上了：只换他的模型，重新说这一句', async () => {
    const d = discussion('D', ['甲', '乙'], 1);
    d.participants[1]!.model = 'openai/blocked';
    const task = await create([d], []);
    const yi = runsOf('D', task).find((r) => r.model === 'openai/blocked')!;
    await finish(yi.runId, 'failed', { error: REGION });
    const again = runOf('D', task);
    expect(again.model).toBe('deepseek/x');
    expect(again.prompt).toContain('你是「乙」');
    const node = (await service.get(OWNER, task.id)).nodes[0];
    expect(node?.discussion?.participants.map((p) => p.model)).toEqual([
      'deepseek/甲',
      'deepseek/x',
    ]);
    expect(node?.warning).toBe('「乙」原定的模型 openai/blocked 在当前网络用不了，改用 deepseek/x');
  });
});
