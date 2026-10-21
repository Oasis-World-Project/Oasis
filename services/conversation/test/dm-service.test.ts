import type { StreamEvent } from '@oasis/contracts/conversation';
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, ConversationRepo, Message } from '../src/repo/conversation-repo.ts';
import { createDmService } from '../src/service/dm-service.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';

/** 内存版仓库 */
function memoryRepo(): ConversationRepo & { rows: Message[] } {
  const rows: Message[] = [];
  const conversation: Conversation = {
    id: CONV,
    kind: 'dm',
    ownerId: OWNER,
    modelKey: 'claude',
    title: 'Claude',
    createdAt: new Date(),
    lastMessageAt: null,
  };
  let seq = 0;
  return {
    rows,
    upsertDm: async () => conversation,
    listDms: async () => [conversation],
    findOwned: async (id, owner) => (id === CONV && owner === OWNER ? conversation : undefined),
    insertMessage: async (m) => {
      const row: Message = {
        ...m,
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        error: null,
        createdAt: new Date(Date.now() + seq),
      };
      rows.push(row);
      return row;
    },
    finishMessage: async (id, update) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, {
        content: update.content,
        status: update.status,
        error: update.error ?? null,
      });
      return row;
    },
    touchConversation: async () => {},
    recentComplete: async (_c, limit, excludeId) =>
      rows.filter((r) => r.status === 'complete' && r.id !== excludeId).slice(-limit),
    listMessages: async () => rows,
  };
}

const agent = Fastify();
agent.get('/internal/models/:key/route', async () => ({
  key: 'claude',
  name: 'Claude',
  providerModel: 'anthropic/x',
  systemPrompt: '你是 Claude',
}));

let gatewayMode: 'ok' | 'broke' | 'midway' = 'ok';
const seenRequests: { payer: unknown; body: { messages: { role: string; content: string }[] } }[] =
  [];
const modelGateway = Fastify();
modelGateway.post('/internal/v1/chat/completions', async (request, reply) => {
  seenRequests.push({ payer: request.headers['x-oasis-payer-id'], body: request.body as never });
  if (gatewayMode === 'broke')
    return reply
      .code(402)
      .send({ error: { code: 'insufficient_balance', message: '额度不够了', requestId: 'r' } });
  reply.header('content-type', 'text/event-stream');
  const parts = [`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，' } }] })}\n\n`];
  if (gatewayMode === 'midway')
    parts.push(`data: ${JSON.stringify({ error: { message: '回复中断了' } })}\n\n`);
  else
    parts.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '我在。' } }] })}\n\n`,
      'data: [DONE]\n\n',
    );
  return parts.join('');
});

let repo: ReturnType<typeof memoryRepo>;
let service: ReturnType<typeof createDmService>;
let agentUrl = '';
let gatewayUrl = '';
beforeAll(async () => {
  agentUrl = await agent.listen({ port: 0, host: '127.0.0.1' });
  gatewayUrl = await modelGateway.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await agent.close();
  await modelGateway.close();
});
beforeEach(() => {
  gatewayMode = 'ok';
  seenRequests.length = 0;
  repo = memoryRepo();
  service = createDmService({
    repo,
    agent: createServiceClient('agent', agentUrl),
    modelGateway: createServiceClient('model-gateway', gatewayUrl),
    historyLimit: 20,
    replyMaxTokens: 256,
    logger: pino({ level: 'silent' }),
  });
});

async function send(content: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await service.sendMessage({
    ownerId: OWNER,
    conversationId: CONV,
    content,
    requestId: 'r',
    emit: (e) => events.push(e),
  });
  return events;
}

describe('私聊发消息', () => {
  it('先确认收到，再逐段推送回复，最后存下完整回复；由会话主人付费', async () => {
    const events = await send('在吗');
    expect(events.map((e) => e.type)).toEqual(['accepted', 'delta', 'delta', 'done']);
    const done = events.at(-1) as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message).toMatchObject({
      role: 'assistant',
      content: '你好，我在。',
      status: 'complete',
    });
    expect(seenRequests[0]!.payer).toBe(OWNER);
    expect(seenRequests[0]!.body.messages).toEqual([
      { role: 'system', content: '你是 Claude' },
      { role: 'user', content: '在吗' },
    ]);
  });

  it('第二轮带上前面的对话作为上下文', async () => {
    await send('在吗');
    await send('今天周几');
    expect(seenRequests[1]!.body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('额度不够时这条回复标记失败，并给出能看懂的原因', async () => {
    gatewayMode = 'broke';
    const events = await send('在吗');
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'insufficient_balance',
      message: '额度不够了，这条没有回复',
    });
    expect(repo.rows.at(-1)).toMatchObject({ status: 'failed', error: '额度不够了，这条没有回复' });
  });

  it('回复中途断了，保留已经收到的部分', async () => {
    gatewayMode = 'midway';
    const events = await send('在吗');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'stream_interrupted' });
    expect(repo.rows.at(-1)).toMatchObject({ status: 'failed', content: '你好，' });
  });

  it('别人的会话访问不到', async () => {
    await expect(
      service.listMessages('11111111-1111-4111-8111-111111111111', CONV),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
