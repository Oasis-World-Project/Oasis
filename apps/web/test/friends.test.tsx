// 好友：「我」页改资料；私聊页里按账号 ID 加好友、同意别人的申请、和好友聊天；和好友的私聊页。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, profileOf, USER } from './fake-api.ts';
import { Stream } from './group-stream.ts';

const pal = '00000000-0000-4000-8000-000000000002',
  other = '00000000-0000-4000-8000-000000000003',
  stranger = '00000000-0000-4000-8000-000000000004',
  request = '00000000-0000-4000-8000-000000000081',
  chat = '00000000-0000-4000-8000-000000000091';
const at = '2026-11-16T02:00:00Z';
const direct = {
  id: chat,
  kind: 'direct',
  title: '私聊',
  ownerId: USER.id,
  memberCount: 2,
  aiCount: 0,
  light: 'coral',
  createdAt: at,
  historyNotice: GROUP_HISTORY_NOTICE,
  options: { light: 'coral', speak: 'mention' },
  members: [
    { userId: USER.id, displayName: '阿凯', joinedAt: at },
    { userId: pal, displayName: '阿杰', joinedAt: at },
  ],
  ais: [],
  messages: [
    {
      id: '00000000-0000-4000-8000-000000000101',
      seq: 1,
      authorId: pal,
      displayName: '阿杰',
      role: 'user',
      content: '在吗',
      status: 'complete',
      error: null,
      createdAt: at,
      kind: 'text',
      data: {},
    },
  ],
};
async function open(path: string) {
  vi.stubGlobal('EventSource', Stream);
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
  return router;
}
afterEach(() => {
  vi.unstubAllGlobals();
  Stream.instances = [];
  localStorage.clear();
});

describe('好友', () => {
  it('「我」页：看得到自己的账号 ID；改了名字和签名才能保存', async () => {
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path, body) =>
        method === 'PUT' && path === '/identity/v1/me/profile'
          ? json(200, { ...USER, ...(body as object) })
          : undefined,
    });
    await open('/me');
    expect(await screen.findByText(USER.accountNo)).toBeTruthy();
    const save = screen.getByRole('button', { name: '保存资料' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: ' 凯 ' } });
    fireEvent.change(screen.getByLabelText('签名'), { target: { value: '周五见' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path === '/identity/v1/me/profile')?.body).toEqual({
        name: '凯',
        bio: '周五见',
        gender: '',
        region: '',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toBe('存好了');
  });

  it('私聊页：同意别人发来的申请；按账号 ID 查到人、写验证消息发申请；好友点「聊天」进私聊页', async () => {
    const state = installFakeApi({
      signedIn: true,
      friends: {
        friends: [{ profile: profileOf(pal, '阿杰'), since: at, chatId: null }],
        incoming: [
          { id: request, profile: profileOf(other, '林夏'), message: '我是林夏', createdAt: at },
        ],
        outgoing: [],
      },
      extra: (method, path) => {
        if (method === 'GET' && path.startsWith('/identity/v1/users/lookup'))
          return json(200, profileOf(stranger, '老周', '40000004'));
        if (method === 'POST' && path === '/conversation/v1/friends/requests')
          return json(200, { status: 'requested' });
        if (method === 'POST' && path.endsWith('/accept'))
          return new Response(null, { status: 204 });
        if (method === 'POST' && path.endsWith(`/friends/${pal}/chat`))
          return json(200, { id: chat });
      },
    });
    const router = await open('/dms');
    const news = await screen.findByRole('region', { name: '新朋友' });
    expect(within(news).getByText('我是林夏')).toBeTruthy();
    fireEvent.click(within(news).getByRole('button', { name: '同意' }));
    await waitFor(() =>
      expect(state.requests).toContain(`POST /conversation/v1/friends/requests/${request}/accept`),
    );

    fireEvent.click(screen.getByRole('button', { name: '加好友' }));
    const dialog = await screen.findByRole('dialog', { name: '加好友' });
    // 只收数字
    fireEvent.change(within(dialog).getByLabelText('账号 ID'), { target: { value: '4000 0004' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '查找' }));
    expect(await within(dialog).findByText('老周')).toBeTruthy();
    expect(state.requests).toContain('GET /identity/v1/users/lookup?accountNo=40000004');
    fireEvent.change(within(dialog).getByLabelText('验证消息'), { target: { value: '周五见过' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加为好友' }));
    expect((await within(dialog).findByRole('status')).textContent).toContain('等对方同意');
    expect(state.bodies.find((b) => b.path === '/conversation/v1/friends/requests')?.body).toEqual({
      userId: stranger,
      message: '周五见过',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));

    const friends = screen.getByRole('region', { name: '好友' });
    fireEvent.click(await within(friends).findByRole('button', { name: '聊天' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chats/${chat}`));
  });

  it('和好友的私聊页：页头是对方，没有 @、群设置和工作台；不再是好友时说聊天不在了', async () => {
    installFakeApi({ signedIn: true });
    await open(`/chats/${chat}`);
    await waitFor(() => expect(Stream.instances).toHaveLength(1));
    act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot: direct }));
    expect(await screen.findByRole('heading', { name: '阿杰' })).toBeTruthy();
    expect(screen.getByText('在吗')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '消息' })).toBeTruthy();
    for (const name of ['召唤某个 AI 或某人', '群设置', '叫 AI 进群'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('region', { name: '工作台（收起）' })).toBeNull();
    act(() => Stream.instances[0]!.emit({ type: 'removed' }));
    expect(screen.getByRole('alert').textContent).toContain('已经不是好友');
  });
});
