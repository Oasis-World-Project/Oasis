import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, profileOf } from './fake-api.ts';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';
import { Stream } from './group-stream.ts';

const id = '00000000-0000-4000-8000-000000000061',
  user = '00000000-0000-4000-8000-000000000001',
  owner = '00000000-0000-4000-8000-000000000002';
const snapshot = {
  id,
  title: '周末计划',
  ownerId: owner,
  memberCount: 2,
  aiCount: 0,
  light: 'coral',
  createdAt: '2026-11-02T00:00:00Z',
  historyNotice: GROUP_HISTORY_NOTICE,
  options: { light: 'coral', speak: 'mention' },
  members: [
    { userId: owner, displayName: '群主', joinedAt: '2026-11-02T00:00:00Z' },
    { userId: user, displayName: '小林', joinedAt: '2026-11-02T00:00:00Z' },
  ],
  ais: [],
  messages: [
    {
      id: '00000000-0000-4000-8000-000000000003',
      seq: 1,
      authorId: owner,
      displayName: '群主',
      role: 'user',
      content: '欢迎加入',
      status: 'complete',
      error: null,
      createdAt: '2026-11-02T00:00:00Z',
      kind: 'text',
      data: {},
    },
  ],
};
async function open(path = '/groups') {
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
  return router;
}
afterEach(() => {
  vi.unstubAllGlobals();
  Stream.instances = [];
});
describe('群聊成员页面', () => {
  it('成员弹层：群主把还不在群里的好友直接拉进来，自己能改群昵称；不出现邀请码', async () => {
    const pal = '00000000-0000-4000-8000-000000000009';
    const mine = { ...snapshot, ownerId: user };
    const state = installFakeApi({
      signedIn: true,
      friends: {
        friends: [
          // 已经在群里的好友不列
          { profile: profileOf(owner, '群主'), since: snapshot.createdAt, chatId: null },
          { profile: profileOf(pal, '阿杰'), since: snapshot.createdAt, chatId: null },
        ],
        incoming: [],
        outgoing: [],
      },
      extra: (method, path) =>
        (method === 'POST' && path.endsWith('/members')) ||
        (method === 'PUT' && path.endsWith('/nickname'))
          ? json(200, mine)
          : undefined,
    });
    vi.stubGlobal('EventSource', Stream);
    await open(`/groups/${id}`);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot: mine }));
    fireEvent.click(await screen.findByRole('button', { name: '成员 · 2' }));
    const popover = screen.getByRole('dialog', { name: '成员 · 2' });
    expect(within(popover).queryByRole('button', { name: '把 群主 拉进群' })).toBeNull();
    fireEvent.click(await within(popover).findByRole('button', { name: '把 阿杰 拉进群' }));
    await waitFor(() =>
      expect(state.bodies.find((value) => value.path.endsWith('/members'))?.body).toEqual({
        userId: pal,
      }),
    );
    fireEvent.change(within(popover).getByLabelText('我在本群的昵称'), {
      target: { value: ' 小林子 ' },
    });
    fireEvent.click(within(popover).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(state.bodies.find((value) => value.path.endsWith('/nickname'))?.body).toEqual({
        nickname: '小林子',
      }),
    );
    expect(screen.queryByText(/邀请/)).toBeNull();
  });
  it('不是群主：成员弹层里没有拉好友；群列表页也没有「用邀请加入」', async () => {
    installFakeApi({ signedIn: true });
    vi.stubGlobal('EventSource', Stream);
    const router = await open(`/groups/${id}`);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot }));
    fireEvent.click(await screen.findByRole('button', { name: '成员 · 2' }));
    const popover = screen.getByRole('dialog', { name: '成员 · 2' });
    expect(within(popover).getByLabelText('我在本群的昵称')).toBeTruthy();
    expect(within(popover).queryByText('拉好友进群')).toBeNull();
    await act(() => router.navigate({ to: '/groups' }));
    expect(await screen.findByRole('region', { name: '我的群' })).toBeTruthy();
    expect(screen.queryByText(/邀请/)).toBeNull();
  });
  it('重复的连接重放不重复显示消息；撤权清除消息并关连接', async () => {
    installFakeApi({ signedIn: true });
    vi.stubGlobal('EventSource', Stream);
    await open(`/groups/${id}`);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    const stream = Stream.instances[0]!;
    act(() => {
      stream.emit({ type: 'snapshot', snapshot });
      stream.emit({ type: 'snapshot', snapshot });
    });
    expect(screen.getAllByText('欢迎加入')).toHaveLength(1);
    act(() => stream.emit({ type: 'removed' }));
    expect(screen.queryByText('欢迎加入')).toBeNull();
    expect(stream.close).toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('已不在群里');
  });
  it('发送失败保留草稿，重试沿用同一请求号', async () => {
    let fail = true;
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method === 'POST' && path.endsWith('/messages')) {
          if (fail) {
            fail = false;
            return json(503, { error: { code: 'busy', message: '稍后重试' } });
          }
          return json(200, snapshot);
        }
      },
    });
    vi.stubGlobal('EventSource', Stream);
    await open(`/groups/${id}`);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot }));
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe(
        '你好',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(state.bodies.filter((value) => value.path.endsWith('/messages'))).toHaveLength(2),
    );
    const [a, b] = state.bodies
      .filter((value) => value.path.endsWith('/messages'))
      .map((value) => value.body);
    expect(a).toEqual(b);
  });
});
