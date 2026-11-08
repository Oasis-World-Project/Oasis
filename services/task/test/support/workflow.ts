// 工作流服务测试的公共部分：假 harness / agent / model-gateway（一个 Fastify）、假关卡、每个测试前重建服务，
// 以及建任务、结束运行、看状态的帮手。各个 workflow-*.test.ts 共用。
import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { Gate, GateResult } from '../../src/service/gate.ts';
import { createWorkflowService } from '../../src/service/workflow-service.ts';
import { events, memoryStore } from './memory-store.ts';

/** 测试里会整个换掉的假结果 */
export const fake = {
  rejectNext: false,
  unavailable: [] as string[],
  gateResults: [] as (string[] | GateResult | 'throw')[],
  gateWaits: [] as (Promise<void> | undefined)[],
  /** 工具目录里另加的工具（带参数定义；同名的盖过默认的） */
  tools: [] as Record<string, unknown>[],
};

export const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
export const STRANGER = '1d1d1d1d-1d1d-4d1d-8d1d-1d1d1d1d1d1d';

/** 假 harness：记下提交的运行、追问、停止和取消；可以设置下一次提交返回 4xx 或连不上 */
export const submitted: Record<string, unknown>[] = [];
export const messages: { runId: string; text: string }[] = [];
export const cancelled: string[] = [];
export const stopped: string[] = [];
export let harnessKnows = new Set<string>();
export let finishedRemote = new Map<string, Record<string, unknown>>();
/** 这些运行的持久工作目录不在了：接着它们做时 harness 返回 409 workspace_unavailable */
export let lostWorkspaces = new Set<string>();
export const harness = Fastify();
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
  const body = request.body as { runId: string; continueFrom?: string };
  if (fake.rejectNext) {
    fake.rejectNext = false;
    return reply
      .code(409)
      .send({ error: { code: 'input_run_unavailable', message: '上游没了', requestId: 'r' } });
  }
  if (body.continueFrom && lostWorkspaces.has(body.continueFrom))
    return reply.code(409).send({
      error: {
        code: 'workspace_unavailable',
        message: '原会话的工作目录已经不在了，接不上原会话',
        requestId: 'r',
      },
    });
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
export let plans = new Map<string, string>();
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
export const decisions: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
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
harness.get('/internal/v1/models/unavailable', async () => ({ models: fake.unavailable }));
/** 假 model-gateway：工具目录（联网搜索没配 Key，不可用） */
export const toolEntry = (key: string, estimateMicro: number, available: boolean) => ({
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
  tools: [
    toolEntry('image.generate', 40_000, true),
    toolEntry('web.search', 8_000, false),
    ...fake.tools,
  ],
}));
/** 假 harness：运行过程（记下问的是哪次运行） */
export const eventRequests: string[] = [];
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
export function runBody(id: string, status: string, extra: Record<string, unknown> = {}) {
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
export const gateSignals: (AbortSignal | undefined)[] = [];
export const gateCalls: { runId: string; expects: unknown[] }[] = [];
export const gate = {
  async check(input: { runId: string; expects: unknown[]; signal?: AbortSignal }) {
    gateSignals.push(input.signal);
    gateCalls.push({ runId: input.runId, expects: input.expects });
    await fake.gateWaits.shift();
    const next = fake.gateResults.shift() ?? [];
    if (next === 'throw') throw new Error('关卡断了');
    return Array.isArray(next) ? { unmet: next } : next;
  },
};

export let store: ReturnType<typeof memoryStore>;
export let service: ReturnType<typeof createWorkflowService>;
export let harnessUrl: string;
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
  fake.rejectNext = false;
  lostWorkspaces = new Set();
  plans = new Map();
  fake.unavailable = [];
  fake.tools = [];
  events.length = 0;
  fake.gateResults = [];
  fake.gateWaits = [];
  gateSignals.length = 0;
  gateCalls.length = 0;
  store = memoryStore();
  service = createWorkflowService({
    store,
    harness: createServiceClient('harness', harnessUrl),
    gate: gate as unknown as Gate,
    maxParallel: 3,
    maxToolChildren: 6,
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

export const work = (key: string, title = key) => ({
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
export const discussion = (key: string, names: string[], rounds = 2) => ({
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
export type PlanNode = ReturnType<typeof work> | ReturnType<typeof discussion>;
export const create = (
  keys: (string | PlanNode)[],
  edges: [string, string][],
  estimateMicro?: number,
) =>
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
export const createPlanned = async (body: Parameters<typeof service.create>[0]) => {
  const planners = () => submitted.filter((s) => !s.nodeId).length;
  const before = planners();
  const task = await service.create(body);
  await vi.waitFor(() => expect(planners()).toBe(before + 1));
  return task;
};
export interface Submitted {
  runId: string;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  continueFrom?: string;
  goal?: boolean;
}
export const runsOf = (key: string, task: { nodes: { id: string; key: string }[] }) => {
  const nodeId = task.nodes.find((n) => n.key === key)?.id;
  return submitted.filter((s) => s.nodeId === nodeId) as unknown as Submitted[];
};
export const runOf = (key: string, task: { nodes: { id: string; key: string }[] }) =>
  runsOf(key, task).at(-1) as Submitted;
export const finish = (
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
export const statusOf = async (taskId: string) => {
  const task = await service.get(OWNER, taskId);
  return { task: task.status, ...Object.fromEntries(task.nodes.map((n) => [n.key, n.status])) };
};

export const keyOf = (task: { nodes: { id: string; key: string }[] }, key: string) =>
  task.nodes.find((n) => n.key === key)?.id as string;
export const errorOf = async (action: () => Promise<unknown>) => {
  const err = (await action().catch((e: unknown) => e)) as HttpError;
  return { status: err.statusCode, message: err.message };
};
