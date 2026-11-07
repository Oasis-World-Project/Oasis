import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunFinished, type EventEnvelope } from '@oasis/contracts/events';
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
} from '../src/repo/task-store.ts';
import type { Gate, GateResult } from '../src/service/gate.ts';
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
  retiredVersion: null,
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

/** 假 harness：记下提交的运行、追问、停止和取消；可以设置下一次提交返回 4xx 或连不上 */
const submitted: Record<string, unknown>[] = [];
const messages: { runId: string; text: string }[] = [];
const cancelled: string[] = [];
const stopped: string[] = [];
let harnessKnows = new Set<string>();
let finishedRemote = new Map<string, Record<string, unknown>>();
let rejectNext = false;
const harness = Fastify();
harness.get('/internal/v1/models/execution', async () => ({
  models: ['deepseek/x', 'openai/blocked'].map((id) => ({
    id,
    name: id,
    contextWindow: 100000,
    maxTokens: 16000,
    input: ['text'],
    reasoning: true,
  })),
}));
harness.get('/internal/execution/environment', async () => ({
  image: 'oasis/test:1',
  imageId: 'sha256:test',
  software: { node: '24' },
  capabilities: ['node'],
  notes: [],
}));
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
/** 假 agent：经验手册；假 model-gateway：Jev 判断属于哪类（「图片类」算是） */
const decisions: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
harness.get('/internal/playbooks', async () => ({
  playbooks: [
    { key: 'documents', name: '文档类', when: '文字', content: '# 文档类\n文档的经验' },
    { key: 'images', name: '图片类', when: '图片', content: '# 图片类\n图片的经验' },
  ],
}));
harness.post('/internal/v1/decisions', async (request) => {
  decisions.push({
    headers: request.headers,
    body: request.body as Record<string, unknown>,
  });
  return {
    answers: { p0: { type: 'noul', noul: 0.2 }, p1: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 1, output_tokens: 1, cost: 0 },
  };
});
/** 假 model-gateway：在当前网络用不了的模型 */
let unavailable: string[] = [];
harness.get('/internal/v1/models/unavailable', async () => ({ models: unavailable }));
/** 假 model-gateway：工具目录（联网搜索没配 Key，不可用） */
const toolEntry = (key: string, estimateMicro: number, available: boolean) => ({
  key,
  name: key,
  description: `${key} 的说明`,
  usage: `oasis-tool ${key}`,
  unit: '次',
  estimateMicro,
  long: false,
  available,
  models: [],
  defaultModel: null,
});
harness.get('/internal/v1/tools', async () => ({
  tools: [toolEntry('image.generate', 40_000, true), toolEntry('web.search', 8_000, false)],
}));
/** 假 harness：运行过程（记下问的是哪次运行） */
const eventRequests: string[] = [];
harness.get('/internal/runs/:id/events', async (request) => {
  const { id } = request.params as { id: string };
  eventRequests.push(id);
  return {
    events: [
      { seq: 0, kind: 'assistant_text', data: { text: id }, createdAt: new Date().toISOString() },
    ],
  };
});
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
let gateResults: (string[] | GateResult | 'throw')[] = [];
let gateWaits: (Promise<void> | undefined)[] = [];
const gateSignals: (AbortSignal | undefined)[] = [];
const gateCalls: { runId: string; expects: unknown[] }[] = [];
const gate = {
  async check(input: { runId: string; expects: unknown[]; signal?: AbortSignal }) {
    gateSignals.push(input.signal);
    gateCalls.push({ runId: input.runId, expects: input.expects });
    await gateWaits.shift();
    const next = gateResults.shift() ?? [];
    if (next === 'throw') throw new Error('关卡断了');
    return Array.isArray(next) ? { unmet: next } : next;
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
  gateWaits = [];
  gateSignals.length = 0;
  gateCalls.length = 0;
  store = memoryStore();
  service = createWorkflowService({
    store,
    harness: createServiceClient('harness', harnessUrl),
    gate: gate as unknown as Gate,
    maxParallel: 3,
    agent: createServiceClient('agent', harnessUrl),
    modelGateway: createServiceClient('model-gateway', harnessUrl),
    planning: {
      planner: 'deepseek/planner',
      defaultModel: 'deepseek/x',
      fallback: { workRun: 3_000, speechRun: 3_000, computeRun: 0, nodeSeconds: 600 },
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
  deliver: ['*.md'],
  tools: [] as { key: string; uses: number }[],
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
    materials: [],
    payerId: OWNER,
    title: '测试任务',
    brief: '做一份温馨小屋的介绍',
    ...(estimateMicro ? { estimateMicro } : {}),
    plan: {
      nodes: keys.map((k) => (typeof k === 'string' ? work(k) : k)),
      edges: edges.map(([from, to]) => ({ from, to })),
    },
  });
/** 从任务单建任务：规划员在建任务返回之后才提交，等它交到 harness */
const createPlanned = async (body: Parameters<typeof service.create>[0]) => {
  const planners = () => submitted.filter((s) => !s.nodeId).length;
  const before = planners();
  const task = await service.create(body);
  await vi.waitFor(() => expect(planners()).toBe(before + 1));
  return task;
};
interface Submitted {
  runId: string;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  continueFrom?: string;
  goal?: boolean;
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
  it('完成事件解析保留文件摘要，节点及后续交付不会在异步边界丢失校验信息', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const run = runOf('A', task);
    await service.onRunFinished(
      RunFinished.data.parse({
        runId: run.runId,
        payerId: OWNER,
        taskId: task.id,
        nodeId: task.nodes[0]!.id,
        status: 'succeeded',
        error: null,
        summary: null,
        finishedAt: new Date().toISOString(),
        outputs: [{ path: 'result.md', size: 3, sha256: 'a'.repeat(64) }],
      }),
    );
    expect((await service.get(OWNER, task.id)).nodes.find((n) => n.key === 'A')?.outputs).toEqual([
      { path: 'result.md', size: 3, sha256: 'a'.repeat(64) },
    ]);
    expect(runOf('B', task).inputsFrom).toEqual([{ runId: run.runId, as: 'A' }]);
  });
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

  it('失败有可恢复归档时沿用同一子任务会话和产物', async () => {
    const task = await create(['A'], []);
    const previous = runOf('A', task).runId;
    await finish(previous, 'failed', { resumable: true });
    expect(submitted).toHaveLength(1);
    await service.decide(OWNER, task.id, { choice: 'retry' });
    expect(runOf('A', task)).toMatchObject({ continueFrom: previous, goal: true, inputsFrom: [] });
  });

  it('原生执行器明确失败后报告根因，不在外层复制付费运行，下游不跑', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention).toMatchObject({
      reason: 'node_failed',
      message: '「A」未完成：模型出错',
    });
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(submitted).toHaveLength(1);
  });

  it('明确重试后成功，照常往下走', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    await service.decide(OWNER, task.id, { choice: 'retry' });
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
  });

  it('harness 明确拒绝（4xx）报告错误，不重复提交同一无效请求', async () => {
    rejectNext = true;
    const task = await create(['A'], []);
    expect(submitted).toHaveLength(0);
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
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
    // 修复是单轮的，跑完回到关卡（ADR 0017）
    expect(rework.goal).toBeFalsy();
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

  it('明确没满足最多自动改一次；改过仍没满足就带着提醒往下走，不停下', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    gateResults = [['语气不够友好'], ['语气不够友好']];
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });
    expect(runOf('A', task).continueFrom).toBe(runsOf('A', task).at(-2)?.runId);
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'running',
      A: 'succeeded',
      B: 'running',
    });
    expect(runsOf('A', task)).toHaveLength(2);
    const a = (await service.get(OWNER, task.id)).nodes.find((n) => n.key === 'A')!;
    expect(a.warning).toContain('改过一次仍可能没满足：语气不够友好');
  });

  it('节点检查未返回时多次对账共享同一检查，不重复发起付费验收', async () => {
    const task = await create(['A'], []);
    let release!: () => void;
    gateWaits = [
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    ];
    const pending = finish(runOf('A', task).runId, 'succeeded');
    const overlaps: Promise<void>[] = [];
    try {
      await vi.waitFor(() => expect(gateCalls).toHaveLength(1));
      overlaps.push(service.reconcile(0), service.reconcile(0));
      await new Promise((resolve) => setImmediate(resolve));
      expect(gateCalls).toHaveLength(1);
    } finally {
      release();
    }
    await Promise.all([pending, ...overlaps]);
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
    expect(gateCalls).toHaveLength(1);
  });

  it.each(['stop', 'cancel'] as const)(
    '验收长判断由用户 %s 中止，迟到结果不能覆盖用户状态',
    async (how) => {
      const task = await create(['A'], []);
      let release!: () => void;
      gateWaits = [
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      ];
      const pending = finish(runOf('A', task).runId, 'succeeded');
      try {
        await vi.waitFor(() => expect(gateSignals).toHaveLength(1));
        await service[how](OWNER, task.id);
        expect(gateSignals[0]?.aborted).toBe(true);
      } finally {
        release();
      }
      await pending;
      expect((await service.get(OWNER, task.id)).status).toBe(
        how === 'stop' ? 'stopped' : 'cancelled',
      );
    },
  );

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
    expect(gateCalls.map((c) => c.runId)).toEqual([summary.runId]);
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

  it('发言最终失败时保留原因并结束同轮其他在途发言，不自行从头复制', async () => {
    const task = await create([discussion('D', ['甲', '乙'], 1)], []);
    const [jia, yi] = runsOf('D', task);
    await finish(jia?.runId as string, 'failed');
    expect(await statusOf(task.id)).toMatchObject({ task: 'needs_attention', D: 'failed' });
    expect(cancelled).toEqual([yi?.runId]);
    expect(submitted).toHaveLength(2);
  });
});

const keyOf = (task: { nodes: { id: string; key: string }[] }, key: string) =>
  task.nodes.find((n) => n.key === key)?.id as string;
const errorOf = async (action: () => Promise<unknown>) => {
  const err = (await action().catch((e: unknown) => e)) as HttpError;
  return { status: err.statusCode, message: err.message };
};

describe('停止与继续', () => {
  it.each([false, true])(
    '制作成功、检查被暂停后恢复，追加要求=%s 时正确选择复查或原会话续作',
    async (additionalNote) => {
      const task = await create(['A', 'B'], [['A', 'B']]);
      const original = runOf('A', task);
      gateResults = ['throw'];
      await finish(original.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
      expect(await statusOf(task.id)).toMatchObject({ A: 'checking', B: 'waiting' });
      await service.stop(OWNER, task.id);
      if (additionalNote) await service.message(OWNER, task.id, keyOf(task, 'A'), '加上新要求');
      await service.run(OWNER, task.id);
      if (additionalNote) {
        expect(runsOf('A', task)).toHaveLength(2);
        expect(runOf('A', task).continueFrom).toBe(original.runId);
        expect(runOf('A', task).prompt).toContain('加上新要求');
        expect(gateCalls).toHaveLength(1);
        expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });
      } else {
        expect(runsOf('A', task)).toHaveLength(1);
        expect(gateCalls.map((call) => call.runId)).toEqual([original.runId, original.runId]);
        expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
      }
    },
  );

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
  const failNode = async (task: { nodes: { id: string; key: string }[] }, key: string) => {
    await finish(runOf(key, task).runId, 'failed');
  };

  it('节点失败 → 用现在的结果继续：它算完成并留提醒，下游照常跑（拿不到它的产出）', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await failNode(task, 'A');
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
    await failNode(task, 'A');
    await service.decide(OWNER, task.id, { choice: 'retry' });
    expect((await service.get(OWNER, task.id)).nodes[0]).toMatchObject({
      status: 'running',
      attempts: 1,
    });
    expect(submitted).toHaveLength(2);
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

  it('完成后的预览结算只留在账本，不回写生成任务花费', async () => {
    const task = await create(['A'], [], 1_000);
    await service.onCallSettled({
      callId: CALL(8),
      taskId: task.id,
      nodeId: null,
      chargedMicro: 500,
      model: 'preview',
    });
    expect((await service.get(OWNER, task.id)).spentMicro).toBe(0);
  });

  it('估价不产生预算：超过旧的三倍阈值仍运行，结算幂等', async () => {
    const task = await create(['A', 'B'], [], 1_000);
    expect(task.budgetLimitMicro).toBeNull();
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    await settle(task.id, keyOf(task, 'B'), CALL(2), 1_500);
    const detail = await service.get(OWNER, task.id);
    expect(detail.spentMicro).toBe(3_500);
    expect(detail.nodes.find((n) => n.key === 'A')?.spentMicro).toBe(2_000);
    expect(detail.status).toBe('running');
    expect(stopped).toEqual([]);
  });

  it('预算只是参考（ADR 0016）：花得比预估多也照常运行，不暂停、不停节点', async () => {
    const task = await create(['A', 'B'], [], 1_000);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 3_500);
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'running', attention: null, spentMicro: 3_500 });
    expect(stopped).toHaveLength(0);
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
    createPlanned({
      ownerId: OWNER,
      materials: [],
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

  it('节点花费越过份额的 1.5 倍、2 倍时各提醒一次收尾，之后不再重复', async () => {
    const task = await createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: 'b',
      sheet: {
        ...sheetOf(),
        budget: { tier: 'standard', micro: 100_000, minutes: 5, steps: [] },
      },
    });
    await plannerDone(
      JSON.stringify({
        nodes: [work('write', '写文案')],
        edges: [],
        deliverables: { 首页文案: 'write' },
      }),
    );
    const detail = await service.get(OWNER, task.id);
    const node = detail.nodes[0]!;
    const run = runOf('write', detail).runId;
    const settle = (n: number, micro: number) =>
      service.onCallSettled({
        callId: `00000000-0000-4000-8000-00000000010${n}`,
        taskId: task.id,
        nodeId: node.id,
        chargedMicro: micro,
      });
    await settle(1, 120_000);
    expect(messages).toEqual([]);
    await settle(2, 40_000);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ runId: run });
    expect(messages[0]?.text).toContain('已花 $0.16（分到约 $0.10）');
    expect(messages[0]?.text).toContain('请收尾');
    await settle(3, 10_000);
    expect(messages).toHaveLength(1);
    await settle(4, 50_000);
    expect(messages).toHaveLength(2);
    await settle(5, 100_000);
    expect(messages).toHaveLength(2);
  });

  it('建任务后先规划；方案过了规划门就建节点、算预估和上限、开跑，并发出状态事件', async () => {
    const task = await fromSheet();
    expect(task).toMatchObject({ status: 'planning', nodes: [], sheet: { title: '小木屋首页' } });
    const [planner] = plannerRuns();
    expect(planner?.model).toBe('deepseek/planner');
    // 规划员不分档：一律最强型号、最高思考档
    expect((planner as unknown as { reasoningEffort?: string }).reasoningEffort).toBe('max');
    // 规划员只写方案交给规划门：单轮，不用持续目标
    expect((planner as unknown as { goal?: boolean }).goal).toBeFalsy();
    expect(planner?.prompt).toContain('首页文案');
    expect(planner?.prompt).toContain('deepseek/x（DeepSeek');
    expect(planner?.prompt).not.toContain('最多 4 个节点');
    // 经验手册（ADR 0016 §6）：不再让 Jev 挑，全文放进 in/playbooks/，说明里只列名字和适用范围
    expect(planner?.prompt).toContain('in/playbooks/images.md：图片类（图片）');
    expect(planner?.prompt).not.toContain('图片的经验');
    const inputs = (planner as unknown as { inputs: { path: string; contentBase64: string }[] })
      .inputs;
    expect(inputs.map((i) => i.path)).toEqual(['playbooks/documents.md', 'playbooks/images.md']);
    expect(Buffer.from(inputs[1]!.contentBase64, 'base64').toString()).toContain('图片的经验');
    expect(decisions.filter((d) => d.headers['x-oasis-task-id'] === task.id)).toHaveLength(0);

    await plannerDone(goodPlan);
    const detail = await service.get(OWNER, task.id);
    // 两个节点各 3000（没有记录时的兜底），不再乘 1.2
    expect(detail).toMatchObject({
      status: 'running',
      estimateMicro: 6_000,
      budgetLimitMicro: null,
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

  it('规划员看得到能用的工具；节点分到的工具计入预估，并写进节点的说明', async () => {
    const task = await fromSheet();
    const [planner] = plannerRuns();
    expect(planner?.prompt).toContain('- image.generate（image.generate）');
    expect(planner?.prompt).toContain('型号与单价：每次约 $0.04');
    expect(planner?.prompt).not.toContain('- web.search');

    await plannerDone(
      JSON.stringify({
        nodes: [{ ...work('draw', '画首屏'), tools: [{ key: 'image.generate', uses: 2 }] }],
        edges: [],
        deliverables: { 首页文案: 'draw' },
      }),
    );
    const detail = await service.get(OWNER, task.id);
    // 3000 + 2 × 40000（工具没有记录时用目录的兜底单价）
    expect(detail.estimateMicro).toBe(83_000);
    expect(detail.nodes[0]?.tools).toEqual([{ key: 'image.generate', uses: 2 }]);
    const prompt = runOf('draw', detail).prompt;
    expect(prompt).toContain('规划建议用：image.generate');
    expect(prompt).toContain('oasis-tool list');
  });

  it('方案里用了不能用的工具：退回给规划员改', async () => {
    await fromSheet();
    await plannerDone(
      JSON.stringify({
        nodes: [{ ...work('find'), tools: [{ key: 'web.search', uses: 1 }] }],
        edges: [],
        deliverables: { 首页文案: 'find' },
      }),
    );
    expect(plannerRuns().at(-1)?.prompt).toContain(
      '节点「find」的工具 web.search 不在可以用的工具里',
    );
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

  it('原生规划失败保留根因；用户选择重新规划后再执行', async () => {
    const task = await fromSheet();
    await plannerDone(undefined, 'failed');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention?.reason).toBe('plan_failed');
    expect(detail.attention?.message).toContain('模型出错');
    expect(plannerRuns()).toHaveLength(1);
    expect((await service.decide(OWNER, task.id, { choice: 'retry' })).status).toBe('planning');
    await plannerDone('不是 JSON');
    await plannerDone('还是错误');
    expect((await service.get(OWNER, task.id)).status).toBe('planning');
    await plannerDone(goodPlan);
    expect((await service.get(OWNER, task.id)).status).toBe('running');
  });

  it('同一个任务 ID 再提交一次：返回已经建好的任务，不建第二个，也不再开规划员', async () => {
    const id = '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a';
    const body = {
      id,
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: sheetOf(),
    };
    const first = await createPlanned(body);
    const again = await service.create(body);
    expect(again.id).toBe(first.id);
    expect((await service.list(OWNER)).filter((t) => t.id === id)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plannerRuns()).toHaveLength(1);
    expect(
      await service.create({ ...body, ownerId: STRANGER, payerId: STRANGER }).then(
        () => 'ok',
        (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
      ),
    ).toBe('task_id_taken');
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
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('# 小木屋');
    expect(
      (await errorOf(() => service.file(OWNER, task.id, keyOf(task, 'A'), '别的.md'))).status,
    ).toBe(404);
  });
});

describe('整体验收（从任务单来的任务）', () => {
  const start = async (
    criteria = ['语气温馨', '不超过 80 字'],
    edges: { from: string; to: string }[] = [],
  ) => {
    const task = await createPlanned({
      ownerId: OWNER,
      materials: [],
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
        edges,
        deliverables: { 首页文案: 'home', 海报文案: 'poster' },
      }),
    );
    await finish(planner.runId, 'succeeded');
    return service.get(OWNER, task.id);
  };

  it('交付文件不齐：只让缺文件的交付节点接着原会话补一次，补齐后才完成', async () => {
    const task = await start();
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.txt', size: 9 }],
    });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: '海报.md', size: 9 }],
    });
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'running', finishedAt: null });
    expect(detail.acceptance?.unmet).toContain('最终交付缺少文件 out/*.md');
    expect(runOf('home', task).continueFrom).toBe(runsOf('home', task)[0]?.runId);
    expect(runOf('home', task).goal).toBeFalsy();
    expect(runOf('home', task).prompt).toContain('最终交付缺少文件 out/*.md');
    expect(runsOf('poster', task)).toHaveLength(1);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'running',
      'accepting',
      'running',
    ]);
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    expect(await service.get(OWNER, task.id)).toMatchObject({
      status: 'succeeded',
      acceptance: { unmet: [] },
    });
    // 整体验收不再调关卡（不对照任务单逐条打分）
    expect(gateCalls).toHaveLength(3);
  });

  const plannerRuns = () => submitted.filter((s) => !s.nodeId) as unknown as Submitted[];
  /** 发起修改后等规划员交到 harness（ADR 0022） */
  const reviseAndWait = async (taskId: string, body: Parameters<typeof service.revise>[1]) => {
    const before = plannerRuns().length;
    const task = await service.revise(taskId, body);
    await vi.waitFor(() => expect(plannerRuns().length).toBe(before + 1));
    return task;
  };
  const planned = async (plan: unknown) => {
    const run = plannerRuns().at(-1)!;
    plans.set(run.runId, JSON.stringify(plan));
    await finish(run.runId, 'succeeded');
    return run;
  };
  const delivered = async (edges: { from: string; to: string }[] = []) => {
    const task = await start(['语气温馨'], edges);
    for (const key of ['home', 'poster'])
      await finish(runOf(key, task).runId, 'succeeded', {
        outputs: [{ path: key + '.md', size: 9 }],
      });
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
    return task;
  };

  it('修改交给规划员看上一版决定怎么改，用户确认后才开跑：接着原会话改、重新做（上一版产出在 in/_previous/）', async () => {
    const task = await delivered([{ from: 'home', to: 'poster' }]);
    const firstHome = runOf('home', task).runId;
    const firstPoster = runOf('poster', task).runId;
    const SHOT = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
    const homeId = keyOf(task, 'home');
    const revised = await reviseAndWait(task.id, {
      ownerId: OWNER,
      request: '标题改短\n批注：\n1.「home.md」画面右上：去掉这句（见截图 批注-home-截图1.png）',
      materials: [{ uploadId: SHOT, name: '批注-home-截图1.png', size: 4 }],
      nodeIds: [homeId],
    });
    expect(revised).toMatchObject({
      id: task.id,
      status: 'planning',
      version: 1,
      revision: { version: 2, stage: 'planning', request: expect.stringContaining('标题改短') },
    });
    expect(revised.materials).toEqual([{ uploadId: SHOT, name: '批注-home-截图1.png', size: 4 }]);
    // 规划中工作流还是上一版
    expect(revised.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'home=succeeded',
      'poster=succeeded',
    ]);
    // 任务列表标出「修改中」；修改附件算任务素材，删私聊时留着
    expect((await service.list(OWNER))[0]).toMatchObject({ id: task.id, revising: true });
    expect(
      await service.materialsInUse(OWNER, [SHOT, '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b']),
    ).toEqual([SHOT]);
    const planner = plannerRuns().at(-1)!;
    expect(planner.prompt).toContain('【修改意见】\n标题改短');
    expect(planner.prompt).toContain('是这些节点交出的：home');
    expect(planner.prompt).toContain('"home.md"');
    expect(planner.prompt).toContain('"home → poster"');

    await planned({
      summary: '首页接着原会话改标题，海报按新首页重新写。',
      nodes: [
        { ...work('home'), from: 'home', mode: 'continue' },
        { ...work('poster'), from: 'poster' },
      ],
      edges: [{ from: 'home', to: 'poster' }],
      deliverables: { 首页文案: 'home', 海报文案: 'poster' },
    });
    const pending = await service.get(OWNER, task.id);
    expect(pending).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'revision_plan', message: '首页接着原会话改标题，海报按新首页重新写。' },
      revision: {
        stage: 'confirm',
        estimateMicro: 6_000,
        changes: [
          { key: 'home', change: 'continue' },
          { key: 'poster', change: 'fresh' },
        ],
      },
    });
    // 确认前不跑任何节点
    expect(runsOf('home', task)).toHaveLength(1);
    expect(runsOf('poster', task)).toHaveLength(1);

    const running = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(running).toMatchObject({ status: 'running', version: 2, revision: null });
    expect(running.versions).toMatchObject([{ version: 1, request: null }]);
    // 节点 ID 不变（成果和运行记录接得上）
    expect(keyOf(running, 'home')).toBe(homeId);
    const home = runOf('home', task) as Submitted & {
      materials: { uploadId: string; path: string }[];
    };
    expect(home.continueFrom).toBe(firstHome);
    expect(home.prompt).toContain('标题改短');
    expect(home.materials).toContainEqual({
      uploadId: SHOT,
      path: 'materials/批注-home-截图1.png',
    });
    expect(runsOf('poster', task)).toHaveLength(1);
    await finish(home.runId, 'succeeded', { outputs: [{ path: 'home.md', size: 10 }] });
    // 重新做：新会话，拿上游新产出，上一版自己的产出放在 in/_previous/
    const poster = runOf('poster', task);
    expect(poster.continueFrom).toBeUndefined();
    expect(poster.inputsFrom).toEqual(
      expect.arrayContaining([
        { runId: home.runId, as: 'home' },
        { runId: firstPoster, as: '_previous' },
      ]),
    );
    expect(poster.prompt).toContain('【上一版】');
    await finish(poster.runId, 'succeeded', { outputs: [{ path: 'poster.md', size: 10 }] });
    expect(await service.get(OWNER, task.id)).toMatchObject({ status: 'succeeded', version: 2 });
    expect((await service.list(OWNER)).map((t) => [t.id, t.revising])).toEqual([[task.id, false]]);
    // 冻结的第 1 版能看，节点和线照旧
    const first = await service.version(OWNER, task.id, 1);
    expect(first.nodes.map((n) => n.key)).toEqual(['home', 'poster']);
    expect(first.edges).toHaveLength(1);
    expect((await errorOf(() => service.version(OWNER, task.id, 2))).status).toBe(404);

    // 规划中不能再发起修改；「不改了」回到修改前的样子
    await reviseAndWait(task.id, { ownerId: OWNER, request: '再改', materials: [] });
    expect(
      (
        await errorOf(() =>
          service.revise(task.id, { ownerId: OWNER, request: '又改', materials: [] }),
        )
      ).status,
    ).toBe(409);
    // 规划中「不改了」走取消：只撤掉这次修改，任务不取消
    const restored = await service.cancel(OWNER, task.id);
    expect(restored).toMatchObject({ status: 'succeeded', version: 2, revision: null });
    expect(cancelled).toContain(plannerRuns().at(-1)!.runId);
  });

  it('沿用、新增、删除节点；规划门挡住拿不到新产出的沿用，退回规划员', async () => {
    const task = await delivered();
    await reviseAndWait(task.id, { ownerId: OWNER, request: '海报换成一句宣传语', materials: [] });
    const planners = plannerRuns().length;
    // 沿用的节点的上游要重新做：它拿不到新产出
    await planned({
      summary: 's',
      nodes: [{ key: 'home', reuse: 'home' }, { ...work('slogan') }],
      edges: [{ from: 'slogan', to: 'home' }],
      deliverables: { 首页文案: 'home', 海报文案: 'slogan' },
    });
    await vi.waitFor(() => expect(plannerRuns()).toHaveLength(planners + 1));
    expect(plannerRuns().at(-1)!.prompt).toContain('沿用的「home」的上游「slogan」要重新做');
    expect((await service.get(OWNER, task.id)).status).toBe('planning');
    await planned({
      summary: '首页不动，海报换成宣传语。',
      nodes: [{ key: 'home', reuse: 'home' }, { ...work('slogan') }],
      edges: [],
      deliverables: { 首页文案: 'home', 海报文案: 'slogan' },
    });
    expect((await service.get(OWNER, task.id)).revision).toMatchObject({
      estimateMicro: 3_000,
      changes: [
        { key: 'home', change: 'reuse' },
        { key: 'slogan', change: 'new' },
        { key: 'poster', change: 'remove' },
      ],
    });
    const posterId = keyOf(task, 'poster');
    const running = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(running.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'home=succeeded',
      'slogan=running',
    ]);
    expect(running.deliverables.map((d) => d.nodeId)).toEqual([
      keyOf(task, 'home'),
      keyOf(running, 'slogan'),
    ]);
    expect(runsOf('home', task)).toHaveLength(1);
    await finish(runOf('slogan', running).runId, 'succeeded', {
      outputs: [{ path: 'slogan.md', size: 9 }],
    });
    expect(await service.get(OWNER, task.id)).toMatchObject({ status: 'succeeded' });
    // 删掉的节点留在第 1 版里，运行记录还能看
    expect((await service.version(OWNER, task.id, 1)).nodes.map((n) => n.key)).toEqual([
      'home',
      'poster',
    ]);
    expect(await service.nodeRuns(OWNER, task.id, posterId)).toHaveLength(1);
  });

  it('修改方案确认前不改了：回到修改前的状态；停下的任务也能改', async () => {
    const task = await start();
    await service.stop(OWNER, task.id);
    expect((await service.get(OWNER, task.id)).status).toBe('stopped');
    await reviseAndWait(task.id, { ownerId: OWNER, request: '换个语气', materials: [] });
    await planned({
      summary: '都重新写。',
      nodes: [
        { ...work('home'), from: 'home' },
        { ...work('poster'), from: 'poster' },
      ],
      edges: [],
      deliverables: { 首页文案: 'home', 海报文案: 'poster' },
    });
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
    expect(await service.decide(OWNER, task.id, { choice: 'cancel' })).toMatchObject({
      status: 'stopped',
      revision: null,
      attention: null,
      version: 1,
    });
  });

  it('交付文件补过一次仍不齐：带着记录交付，不再退回、不停下', async () => {
    const task = await start();
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: 'poster.md', size: 9 }],
    });
    for (let i = 0; i < 2; i++)
      await finish(runOf('home', task).runId, 'succeeded', {
        outputs: [{ path: 'home.txt', size: 9 }],
      });
    const done = await service.get(OWNER, task.id);
    expect(done).toMatchObject({ status: 'succeeded', attention: null });
    expect(done.acceptance?.unmet).toContain('最终交付缺少文件 out/*.md');
    expect(done.acceptance).not.toHaveProperty('repairs');
    expect(runsOf('home', task)).toHaveLength(2);
    expect(runsOf('poster', task)).toHaveLength(1);
  });

  it('跳过失败节点不能让缺文件的整体验收成功', async () => {
    const task = await start();
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    for (let i = 0; i < 3; i++) await finish(runOf('poster', task).runId, 'failed');
    await service.decide(OWNER, task.id, { choice: 'continue' });
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('running');
    expect(detail.acceptance?.unmet).toEqual([
      '最终交付缺少文件 out/*.md',
      '「海报文案」没有交出文件',
    ]);
  });

  it('最终修复沿依赖顺序推进，下游收到上游最新产物且沿用自己的原会话', async () => {
    const task = await start(['两份文案一致'], [{ from: 'home', to: 'poster' }]);
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: 'home.txt', size: 9 }],
    });
    const oldPoster = runOf('poster', task).runId;
    await finish(oldPoster, 'succeeded', { outputs: [{ path: 'poster.md', size: 9 }] });
    const newHome = runOf('home', task).runId;
    expect(runsOf('poster', task)).toHaveLength(1);
    expect(newHome).not.toBe(runsOf('home', task)[0]!.runId);
    await finish(newHome, 'succeeded', { outputs: [{ path: 'home.md', size: 10 }] });
    expect(runOf('poster', task)).toMatchObject({
      continueFrom: oldPoster,
      inputsFrom: [{ runId: newHome, as: 'home' }],
    });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: 'poster.md', size: 10 }],
    });
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
  });

  it('节点没检查到：直接完成、下游开跑，提醒里写明没检查到', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    gateResults = [
      { unmet: [], unchecked: ['验收点检查没做完：连不上模型服务商（网络中断或超时）'] },
    ];
    await finish(runOf('A', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('running');
    expect(detail.attention).toBeNull();
    const a = detail.nodes.find((n) => n.key === 'A')!;
    expect(a.status).toBe('succeeded');
    expect(a.warning).toBe('没检查到：验收点检查没做完：连不上模型服务商（网络中断或超时）');
    expect(runsOf('A', task)).toHaveLength(1);
    expect(runsOf('B', task)).toHaveLength(1);
  });
});

describe('模型在当前网络用不了', () => {
  const REGION =
    '502: {"code":"provider_region_unavailable","message":"这个模型在当前网络所在的地区用不了"}';

  it('规划员的模型目录里去掉用不了的模型（地区限制按厂商：同一家的其他型号也去掉）', async () => {
    unavailable = ['openai/other-model'];
    await createPlanned({
      ownerId: OWNER,
      materials: [],
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
      materials: [],
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
    // 默认模型也不可用：报告实际故障，不反复付费重放
    await finish(next.runId, 'failed', { error: REGION });
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
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

describe('用户给的素材（ADR 0007 §4）', () => {
  it('每次运行都带上素材，同名的加序号；节点说明里列出素材路径', async () => {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: '测试任务',
      brief: '用照片做首页',
      materials: [
        { uploadId: '11111111-0000-4000-8000-000000000001', name: '照片.jpg', size: 10 },
        { uploadId: '11111111-0000-4000-8000-000000000002', name: '照片.jpg', size: 20 },
      ],
      plan: { nodes: [work('A')], edges: [] },
    });
    expect(task.materials).toHaveLength(2);
    const [run] = submitted;
    expect(run!.materials).toEqual([
      { uploadId: '11111111-0000-4000-8000-000000000001', path: 'materials/照片.jpg' },
      { uploadId: '11111111-0000-4000-8000-000000000002', path: 'materials/照片 (2).jpg' },
    ]);
    expect(run!.prompt).toContain('【用户给的素材】');
    expect(run!.prompt).toContain('- materials/照片 (2).jpg');
  });
});

describe('节点详情（ADR 0007 §6）', () => {
  it('列出节点的每次运行；能看指定那次的运行过程，别的节点的运行看不到', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const first = runOf('A', task);
    gateResults = [['缺少文件 out/*.md']];
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'a.txt', size: 3 }] });
    const rework = runOf('A', task);

    const a = keyOf(task, 'A');
    const runs = await service.nodeRuns(OWNER, task.id, a);
    expect(runs.map((r) => [r.id, r.purpose, r.continued])).toEqual([
      [first.runId, 'work', false],
      [rework.runId, 'rework', true],
    ]);

    eventRequests.length = 0;
    await service.nodeEvents(OWNER, task.id, a, -1);
    await service.nodeEvents(OWNER, task.id, a, -1, first.runId);
    expect(eventRequests).toEqual([rework.runId, first.runId]);

    const b = keyOf(task, 'B');
    expect(
      (await errorOf(() => service.nodeEvents(OWNER, task.id, b, -1, first.runId))).status,
    ).toBe(404);
  });

  it('编辑节点时能选的模型和工具：去掉用不了的', async () => {
    unavailable = ['openai/blocked'];
    const options = await service.options();
    expect(options.models.map((m) => m.providerModel)).toEqual(['deepseek/x']);
    expect(options.tools.map((t) => t.key)).toEqual(['image.generate']);
    unavailable = [];
  });
});

describe('删除任务（真删除）', () => {
  /** 建一个只有一个节点的任务并跑完 */
  async function delivered() {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      materials: [],
      title: '测试任务',
      brief: '做一份介绍',
      plan: { nodes: [work('A')], edges: [] },
    });
    await finish(runOf('A', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 3 }] });
    return task;
  }
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
    );
  const deletedEvents = () => events.filter((e) => e.type === 'task.task.deleted');

  it('别人的任务删不了', async () => {
    const task = await delivered();
    expect(await codeOf(service.remove(STRANGER, task.id))).toBe('task_not_found');
    expect(deletedEvents()).toHaveLength(0);
  });

  it('用户删除还在跑的任务：先停掉正在跑的运行，再连同工作流一起删', async () => {
    const task = await create(['A', 'B'], []);
    const running = [runOf('A', task).runId, runOf('B', task).runId];
    await service.remove(OWNER, task.id);
    expect(cancelled.sort()).toEqual([...running].sort());
    expect(deletedEvents().map((e) => e.data)).toEqual([
      expect.objectContaining({ taskId: task.id, ownerId: OWNER }),
    ]);
    await finish(running[0]!, 'cancelled');
    expect(await codeOf(service.get(OWNER, task.id))).toBe('task_not_found');
  });

  it('用户删除已结束的任务：连同工作流一起删；之后迟到的结算和运行结束事件被忽略', async () => {
    const task = await delivered();
    const run = runOf('A', task).runId;
    await service.remove(OWNER, task.id);
    expect(deletedEvents().map((e) => e.data)).toEqual([
      expect.objectContaining({ taskId: task.id, ownerId: OWNER }),
    ]);
    await service.onCallSettled({
      callId: '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b',
      taskId: task.id,
      nodeId: task.nodes[0]!.id,
      chargedMicro: 100,
    });
    await finish(run, 'succeeded');
    expect(await codeOf(service.get(OWNER, task.id))).toBe('task_not_found');
  });
});
