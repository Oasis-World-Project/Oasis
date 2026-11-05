import type { ServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../src/repo/conversation-repo.ts';
import { createContext, rendered, taskLabels } from '../src/service/context.ts';

const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
let seq = 0;
function msg(content: string, extra: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    conversationId: CONV,
    seq,
    authorKind: 'user',
    authorId: 'u',
    content,
    status: 'complete',
    error: null,
    kind: 'text',
    data: {},
    createdAt: new Date(),
    ...extra,
  } as Message;
}

function setup(rows: Message[], window: number, summaryReply: string | null) {
  const conversation = { id: CONV, contextSummary: null } as unknown as Conversation;
  const summaries: { throughSeq: number; text: string }[] = [];
  const summaryCalls: string[] = [];
  const repo = {
    completeMessages: async (_c: string, excludeId: string, beforeSeq?: number) =>
      rows.filter((r) => r.id !== excludeId && (beforeSeq === undefined || r.seq <= beforeSeq)),
    setContextSummary: async (_id: string, s: { throughSeq: number; text: string }) => {
      summaries.push(s);
    },
  };
  const modelGateway = {
    json: async (
      method: string,
      path: string,
      opts: { body?: { messages: { content: string }[] } },
    ) => {
      if (method === 'GET') return { models: [{ id: 'chat/model', contextWindow: window }] };
      summaryCalls.push(opts.body!.messages[0]!.content);
      if (summaryReply === null) throw new Error('摘要模型连不上');
      return { choices: [{ finish_reason: 'stop', message: { content: summaryReply } }] };
    },
  } as unknown as ServiceClient;
  const context = createContext({
    repo,
    modelGateway,
    summaryModel: 'cheap',
    logger: pino({ level: 'silent' }),
  });
  const history = () =>
    context.history({
      conversation,
      excludeId: 'none',
      providerModels: ['chat/model'],
      reserveTokens: 0,
      ownerId: 'u',
      requestId: 'r',
    });
  return { conversation, summaries, summaryCalls, history };
}

describe('私聊的上下文（ADR 0016 §8）', () => {
  it('按任务给消息贴标签：结束了的任务注明只作背景，没整理完的不注', () => {
    const intakeId = 'i-1';
    const taskId = 't-1';
    const request = msg('做个马车', { data: { intent: 'task', intakeId } });
    const card = msg('任务单', {
      authorKind: 'ai',
      kind: 'sheet',
      data: { intakeId, sheet: { title: '3D 马车' }, status: 'confirmed', taskId },
    });
    const delivery = msg('交付了', { authorKind: 'ai', kind: 'delivery', data: { taskId } });
    const open = msg('再做个海报', { data: { intent: 'task', intakeId: 'i-2' } });
    const chat = msg('今天天气不错');
    const labels = taskLabels([request, card, delivery, open, chat]);
    expect(rendered(request, labels)).toBe('【任务「3D 马车」·已交付，只作背景】做个马车');
    expect(rendered(open, labels)).toBe('【任务「没起名」·没整理完】再做个海报');
    expect(rendered(chat, labels)).toBe('今天天气不错');
    expect(labels.get(delivery.id)?.intakeId).toBe(intakeId);
  });

  it('放得下就带整段对话，不压缩、不按条数截', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => msg(`第 ${i} 条`));
    const ctx = setup(rows, 100_000, '摘要');
    const result = await ctx.history();
    expect(result.messages).toHaveLength(50);
    expect(result.summary).toBeNull();
    expect(ctx.summaryCalls).toHaveLength(0);
  });

  it('快到窗口时较早部分压成摘要并存下，下一次接着用，不再压', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => msg(`${i}`.repeat(150)));
    // 每条约 108 token，窗口 600：留下的原文不超过一半（约 2 条）
    const ctx = setup(rows, 600, '较早的要点');
    const first = await ctx.history();
    expect(first.summary).toBe('较早的要点');
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.length).toBeLessThan(10);
    expect(first.messages.at(-1)?.id).toBe(rows.at(-1)!.id);
    expect(ctx.summaries).toEqual([
      { throughSeq: rows[9 - first.messages.length]!.seq, text: '较早的要点' },
    ]);
    expect(ctx.conversation.contextSummary).toEqual(ctx.summaries[0]);
    const again = await ctx.history();
    expect(again.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
    expect(ctx.summaryCalls).toHaveLength(1);
  });

  it('压缩失败时这次只带放得下的最近部分，不存摘要', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => msg(`${i}`.repeat(150)));
    const ctx = setup(rows, 600, null);
    const result = await ctx.history();
    expect(result.summary).toBeNull();
    expect(result.messages.at(-1)?.id).toBe(rows.at(-1)!.id);
    expect(result.messages.length).toBeLessThan(10);
    expect(ctx.summaries).toEqual([]);
  });
});
