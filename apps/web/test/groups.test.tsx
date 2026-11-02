import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';

const id = '00000000-0000-4000-8000-000000000061',
  user = '00000000-0000-4000-8000-000000000001',
  owner = '00000000-0000-4000-8000-000000000002';
const snapshot = {
  id,
  title: '周末计划',
  ownerId: owner,
  memberCount: 2,
  createdAt: '2026-11-02T00:00:00Z',
  historyNotice: GROUP_HISTORY_NOTICE,
  members: [
    { userId: owner, displayName: '群主', joinedAt: '2026-11-02T00:00:00Z' },
    { userId: user, displayName: '小林', joinedAt: '2026-11-02T00:00:00Z' },
  ],
  messages: [
    {
      id: '00000000-0000-4000-8000-000000000003',
      seq: 1,
      authorId: owner,
      displayName: '群主',
      content: '欢迎加入',
      createdAt: '2026-11-02T00:00:00Z',
    },
  ],
};
class Stream {
  static instances: Stream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    Stream.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
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
  it('未登录的邀请跨登录保留在 fragment，读取后清除，不进入请求地址', async () => {
    const state = installFakeApi({ signedIn: false });
    const token = 'a'.repeat(64);
    const router = await open(`/groups#invite=${token}`);
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'join@example.test' },
    });
    expect(router.state.location.search).toEqual({ redirect: '/groups' });
    expect(router.state.location.hash).toBe(`invite=${token}`);
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    fireEvent.change(await screen.findByLabelText('验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }));
    const field = await screen.findByLabelText('邀请码');
    expect((field as HTMLInputElement).value).toBe(token);
    await waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(state.requests.some((path) => path.includes(token))).toBe(false);
  });
  it('加入前必须主动确认历史共享；不出现任务和附件入口', async () => {
    const state = installFakeApi({
      signedIn: true,
      extra: (_method, path) => {
        if (path === '/conversation/v1/groups') return json(200, { groups: [] });
        if (path.endsWith('/invites/preview'))
          return json(200, { title: snapshot.title, historyNotice: GROUP_HISTORY_NOTICE });
        if (path.endsWith('/invites/redeem')) return json(200, snapshot);
      },
    });
    vi.stubGlobal('EventSource', Stream);
    await open();
    fireEvent.change(await screen.findByLabelText('你在群里的名字'), { target: { value: '小林' } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: '查看邀请' }));
    const join = await screen.findByRole('button', { name: '加入群' });
    expect((join as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(join);
    await waitFor(() =>
      expect(
        state.bodies.find((value) => value.path.endsWith('/invites/redeem'))?.body,
      ).toMatchObject({ acceptHistory: true }),
    );
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot }));
    expect(await screen.findByText('欢迎加入')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '更多发送方式' })).toBeNull();
    expect(screen.queryByRole('button', { name: '生成单次邀请' })).toBeNull();
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
