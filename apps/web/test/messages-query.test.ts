// 私聊消息多久刷新一次：有一轮在进行每秒，没有时每 5 秒（别的窗口发进来的话才会自己出现）。
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client.ts';
import { messagesQuery } from '../src/api/queries.ts';

const interval = (state: { data?: unknown; error?: unknown }) => {
  const { refetchInterval } = messagesQuery('00000000-0000-4000-8000-000000000001');
  if (typeof refetchInterval !== 'function') throw new Error('refetchInterval 应该是函数');
  return refetchInterval({ state } as never);
};

describe('私聊消息的刷新间隔', () => {
  it('有一轮在进行每秒刷新；没有时每 5 秒看一次；这段私聊读不了（不是连不上）就不再刷新', () => {
    expect(interval({ data: { messages: [], turn: { runId: 'r' } } })).toBe(1_000);
    expect(interval({ data: { messages: [], turn: null } })).toBe(5_000);
    expect(interval({})).toBe(5_000);
    expect(interval({ error: new ApiError(404, 'conversation_not_found', '没有这段私聊') })).toBe(
      false,
    );
    expect(interval({ error: new ApiError(0, 'network', '连不上') })).toBe(5_000);
  });
});
