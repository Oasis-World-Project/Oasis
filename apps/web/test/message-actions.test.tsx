// 一句话下面的小字按钮：复制每句都有；和 AI 的私聊里我的最后一句能编辑、删除（AI 的回复一起删）。
import type { MessageBody, TurnState } from '@oasis/contracts/conversation';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';

const NOW = '2026-11-27T08:00:00.000Z';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const PATH = `/conversation/v1/conversations/${CONV}/messages`;
const DM = {
  id: CONV,
  kind: 'dm',
  title: 'Claude',
  modelKey: 'claude',
  createdAt: NOW,
  lastMessageAt: NOW,
  turn: null,
};
let seq = 0;
const said = (role: 'user' | 'assistant', content: string, data: object = {}) =>
  ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    role,
    content,
    status: 'complete',
    error: null,
    createdAt: NOW,
    kind: 'text',
    // AI 的话按一段段的 parts 画
    data: role === 'assistant' ? { parts: [{ type: 'text', text: content }], ...data } : data,
  }) as MessageBody;

/** 假后端：删一句时连它后面的都删掉（最后一句和 AI 对它的回复） */
function fakeChat(initial: MessageBody[], turn: TurnState | null = null) {
  const chat = { messages: [...initial] };
  const api = installFakeApi({
    signedIn: true,
    dms: [{ ...DM, turn }],
    extra: (method, path) => {
      if (method === 'GET' && path === PATH) return json(200, { messages: chat.messages, turn });
      if (method === 'DELETE' && path.startsWith(`${PATH}/`)) {
        const at = chat.messages.findIndex((m) => path.endsWith(m.id));
        const removed = chat.messages.slice(at).map((m) => m.id);
        chat.messages = chat.messages.slice(0, at);
        return json(200, { removed });
      }
      return undefined;
    },
  });
  return { chat, api };
}

async function openChat() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/dms/${CONV}`] }),
  });
  await act(() => router.load());
  render(<App />);
}
afterEach(() => vi.unstubAllGlobals());

describe('一句话下面的按钮', () => {
  it('复制每句都有，复制的是说的话；编辑、删除只有我的最后一句有', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fakeChat([
      said('user', '第一句'),
      said('assistant', '好的\n\n```oasis-deliver\n{ "main": "a.md" }\n```'),
      said('user', '第二句'),
      said('assistant', '第二句的回复'),
    ]);
    await openChat();
    await screen.findByText('第二句的回复');
    expect(screen.getAllByRole('button', { name: '复制' })).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[1]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('好的'));
    expect(await screen.findByRole('button', { name: '已复制' })).toBeTruthy();
  });

  it('删除要再点一次确定：这句话和 AI 的回复一起没了；编辑是删掉后把话放回输入框', async () => {
    const second = said('user', '第二句');
    const third = said('user', '第三句');
    const { api } = fakeChat([
      said('user', '第一句'),
      said('assistant', '第一句的回复'),
      second,
      said('assistant', '第二句的回复'),
      third,
      said('assistant', '第三句的回复'),
    ]);
    await openChat();
    await screen.findByText('第三句的回复');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(api.requests.some((request) => request.startsWith('DELETE'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确定删除' }));
    await waitFor(() => expect(api.requests).toContain(`DELETE ${PATH}/${third.id}`));
    await waitFor(() => expect(screen.queryByText('第三句的回复')).toBeNull());
    expect(screen.queryByText('第三句')).toBeNull();

    // 现在第二句是最后一句
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await waitFor(() => expect(api.requests).toContain(`DELETE ${PATH}/${second.id}`));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe(
        '第二句',
      ),
    );
    await waitFor(() => expect(screen.queryByText('第二句的回复')).toBeNull());
    expect(screen.getByText('第一句的回复')).toBeTruthy();
  });

  it('AI 还在做、派到云端的话：没有编辑、删除', async () => {
    fakeChat([said('user', '做个网页'), { ...said('assistant', '在做了'), status: 'streaming' }], {
      runId: RUN,
      startedAt: NOW,
      confirmations: [],
    });
    await openChat();
    await screen.findByText('在做了');
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    // 还在写的那段话没有复制
    expect(screen.getAllByRole('button', { name: '复制' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });

  it('派到云端的最后一句：没有编辑、删除', async () => {
    fakeChat([said('user', '做张海报', { task: true })]);
    await openChat();
    await screen.findByText('做张海报');
    expect(screen.getAllByRole('button', { name: '复制' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });
});
