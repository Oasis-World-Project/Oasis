// 模型调用测试的公共部分：假 billing、假 OpenRouter、内存里的调用记录，每个用例前重置。
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createOpenRouterClient } from '../../src/adapters/openrouter.ts';
import type { CallOutcome, CallsRepo } from '../../src/repo/calls-repo.ts';
import { createChatService } from '../../src/service/chat-service.ts';
import { createMeter } from '../../src/service/metering.ts';

/** 测试里会改的开关和计数（ES 模块导出的变量在别的文件里不能赋值，所以集中放在一个对象里） */
export const fake = {
  balanceEnough: true,
  /** 假的 OpenRouter：流式返回两段内容和最后的用量。 */
  upstreamStatus: 200,
  upstreamMessage: 'boom',
  upstreamBodies: [] as Record<string, unknown>[],
};

export const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const HOLD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export const RUN = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';

/** 假的 billing：记录冻结、结算、退回。 */
export const billingCalls: { path: string; body: Record<string, unknown> }[] = [];
const billing = Fastify();
billing.post('/internal/holds', async (request, reply) => {
  billingCalls.push({ path: '/internal/holds', body: request.body as Record<string, unknown> });
  if (!fake.balanceEnough)
    return reply
      .code(402)
      .send({ error: { code: 'insufficient_balance', message: '额度不够了', requestId: 'r' } });
  return reply.code(201).send({ holdId: HOLD, heldMicro: 1000 });
});
billing.post('/internal/holds/:id/settle', async (request) => {
  billingCalls.push({ path: 'settle', body: request.body as Record<string, unknown> });
  return { chargedMicro: (request.body as { costMicro: number }).costMicro };
});
billing.post('/internal/holds/:id/release', async (_request, reply) => {
  billingCalls.push({ path: 'release', body: {} });
  return reply.code(204).send();
});

const openrouter = Fastify({ bodyLimit: 4 * 1024 ** 2 });
openrouter.post('/chat/completions', async (request, reply) => {
  fake.upstreamBodies.push(request.body as Record<string, unknown>);
  if (fake.upstreamStatus !== 200)
    return reply.code(fake.upstreamStatus).send({ error: { message: fake.upstreamMessage } });
  reply.header('content-type', 'text/event-stream');
  return [
    ': OPENROUTER PROCESSING\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '呀' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.000042 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
});

/** 假的生成记录：中断后按生成 ID 查实际花费（美元） */
export const generationCosts = new Map<string, number>();
export const generationLookups: string[] = [];
openrouter.get('/generation', async (request, reply) => {
  const { id } = request.query as { id: string };
  generationLookups.push(id);
  const cost = generationCosts.get(id);
  if (cost === undefined) return reply.code(404).send({ error: { message: 'not found' } });
  return { data: { id, total_cost: cost } };
});

export const started: Parameters<CallsRepo['start']>[0][] = [];
export const finished: CallOutcome[] = [];
export const repo: CallsRepo = {
  start: async (call) => void started.push(call),
  get: async () => undefined,
  computeForRun: async () => [],
  regionBlockedModels: async () => [],
  staleRunning: async () => [],
  typicalUsage: async () => ({ tools: new Map(), nodes: new Map(), nodeTokens: null }),
  finish: async (_id, outcome) => void finished.push(outcome),
};
export const silent = pino({ level: 'silent' });

export let chat: ReturnType<typeof createChatService>;
beforeAll(async () => {
  const billingUrl = await billing.listen({ port: 0, host: '127.0.0.1' });
  const openrouterUrl = await openrouter.listen({ port: 0, host: '127.0.0.1' });
  chat = createChatService({
    provider: createOpenRouterClient({
      baseUrl: openrouterUrl,
      decisionsUrl: `${openrouterUrl}/decisions`,
      apiKey: 'test-key',
    }),
    meter: createMeter({
      billing: createServiceClient('billing', billingUrl),
      repo,
      logger: silent,
    }),
    prices: () => new Map([['vendor/model', { prompt: 0.0000001, completion: 0.0000005 }]]),
    defaultMaxTokens: 1000,
    maxOutputTokens: 100_000,
    fallbackHoldMicro: 200_000,
    generationLookupDelaysMs: [0, 0],
  });
});
afterAll(async () => {
  await billing.close();
  await openrouter.close();
});
beforeEach(() => {
  billingCalls.length = 0;
  started.length = 0;
  finished.length = 0;
  fake.upstreamBodies = [];
  generationCosts.clear();
  generationLookups.length = 0;
  fake.upstreamStatus = 200;
  fake.upstreamMessage = 'boom';
  fake.balanceEnough = true;
});

export const request = {
  model: 'vendor/model',
  messages: [{ role: 'user' as const, content: '在吗' }],
  stream: true,
};
