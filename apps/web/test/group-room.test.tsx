// 群页里的 AI：舞台、@ 谁谁回、AI 正在写的话原地换新、它忙着时「现在告诉它」、拉群时选光和 AI。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';
import { Stream } from './group-stream.ts';

const id = '00000000-0000-4000-8000-000000000061',
  me = '00000000-0000-4000-8000-000000000001',
  friend = '00000000-0000-4000-8000-000000000002',
  run = '00000000-0000-4000-8000-000000000071';
const at = '2026-11-16T02:00:00Z';
const said = (seq: number, authorId: string, displayName: string, content: string, data = {}) => ({
  id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, '0')}`,
  seq,
  authorId,
  displayName,
  role: 'user',
  content,
  status: 'complete',
  error: null,
  createdAt: at,
  kind: 'text',
  data,
});
const writing = (seq: number, patch = {}) => ({
  ...said(seq, 'claude', 'Claude', '', { runId: run, parts: [] }),
  role: 'assistant',
  status: 'streaming',
  ...patch,
});
const group = (patch = {}) => ({
  id,
  title: '周五发布会筹备',
  ownerId: me,
  memberCount: 2,
  aiCount: 1,
  light: 'coral',
  createdAt: at,
  historyNotice: GROUP_HISTORY_NOTICE,
  options: { light: 'coral', speak: 'mention', assign: 'ai' },
  members: [
    { userId: me, displayName: '我', joinedAt: at },
    { userId: friend, displayName: '阿杰', joinedAt: at },
  ],
  ais: [
    { key: 'claude', role: '统筹、长文', runId: null, startedAt: null, callers: [], heardSeq: 0 },
  ],
  messages: [said(1, friend, '阿杰', '场地定在 B 栋天台')],
  ...patch,
});
/** 往推送里送一份群的样子 */
const push = (stream: Stream, snapshot: unknown) => stream.emit({ type: 'snapshot', snapshot });
async function open(path: string) {
  vi.stubGlobal('EventSource', Stream);
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
  return router;
}
async function room(snapshot = group()) {
  await open(`/groups/${id}`);
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  act(() => push(Stream.instances[0]!, snapshot));
  return Stream.instances[0]!;
}
afterEach(() => {
  vi.unstubAllGlobals();
  Stream.instances = [];
  localStorage.clear();
});

describe('群页里的 AI', () => {
  it('页头是群名和几个人几个 AI；舞台上有它，点开看它负责什么；整屏是这个群的光', async () => {
    installFakeApi({ signedIn: true });
    await room(
      group({ light: 'mint', options: { light: 'mint', speak: 'mention', assign: 'ai' } }),
    );
    expect(screen.getByRole('heading', { name: '周五发布会筹备' })).not.toBeNull();
    expect(screen.getByText('2 个人和 1 个 AI')).not.toBeNull();
    expect(document.querySelector('.oasis-room')?.getAttribute('data-light')).toBe('mint');
    fireEvent.click(screen.getByRole('button', { name: 'Claude，有空' }));
    const card = screen.getByRole('dialog', { name: 'Claude' });
    expect(within(card).getByText(/在这个群里负责统筹、长文/)).not.toBeNull();
    // 「@ 它」：输入框里多一个 @Claude 的胶囊
    fireEvent.click(within(card).getByRole('button', { name: '@ 它' }));
    expect(screen.getByRole('button', { name: '取消 @Claude' })).not.toBeNull();
  });

  it('从「召唤谁来回答」里挑全体 AI，发出去的话带着 @；AI 正在写的话原地换新', async () => {
    const sent = group({
      ais: [{ key: 'claude', role: '', runId: run, startedAt: at, callers: [me], heardSeq: 2 }],
      messages: [said(2, me, '我', '帮忙排个流程', { mentions: [{ kind: 'all' }] }), writing(3)],
    });
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'POST' && path.endsWith('/messages') ? json(200, sent) : undefined,
    });
    const stream = await room();
    fireEvent.click(screen.getByRole('button', { name: '召唤某个 AI 或某人' }));
    const picker = screen.getByRole('listbox', { name: '召唤谁' });
    expect(within(picker).getByText('有空')).not.toBeNull();
    fireEvent.click(within(picker).getByRole('option', { name: '全体 AI' }));
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), {
      target: { value: '帮忙排个流程' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/messages'))?.body).toMatchObject({
        content: '帮忙排个流程',
        mentions: [{ kind: 'all' }],
      }),
    );
    // 发出去以后：我的话带着 @全体 AI，它在舞台上变成在忙，正在想
    expect(await screen.findByText('@全体 AI')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Claude，在忙' })).not.toBeNull();
    expect(screen.getByText('正在想…')).not.toBeNull();
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('');
    // 推送里 live 是同一条消息的新样子：原地换新，不多出一条
    act(() =>
      push(stream, {
        ...sent,
        ais: group().ais,
        messages: [],
        live: [
          writing(3, {
            content: '流程初稿好了',
            status: 'complete',
            data: { runId: run, parts: [{ type: 'text', text: '流程初稿好了' }], spentMicro: 1200 },
          }),
        ],
      }),
    );
    expect(await screen.findByText('流程初稿好了')).not.toBeNull();
    expect(screen.queryByText('正在想…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Claude，有空' })).not.toBeNull();
    // 连接断过、中间它不在了的消息：推送说 gone 就去掉
    act(() => push(stream, { ...sent, ais: group().ais, messages: [], gone: [writing(3).id] }));
    expect(screen.queryByText('流程初稿好了')).toBeNull();
  });

  it('@ 的 AI 还在忙：话下面写着它忙完就看，点「现在告诉它」送进它这一轮', async () => {
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'POST' && path.endsWith('/steer')
          ? new Response(null, { status: 204 })
          : undefined,
    });
    const waiting = said(4, me, '我', '再加一条抽奖', {
      mentions: [{ kind: 'ai', key: 'claude' }],
    });
    await room(
      group({
        ais: [
          { key: 'claude', role: '', runId: run, startedAt: at, callers: [friend], heardSeq: 2 },
        ],
        messages: [writing(3), waiting],
      }),
    );
    expect(screen.getByText(/Claude 在忙，忙完就看/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '现在告诉它' }));
    await waitFor(() =>
      expect(
        state.bodies.find((b) => b.path.endsWith(`/messages/${waiting.id}/steer`))?.body,
      ).toEqual({
        key: 'claude',
      }),
    );
  });

  it('拉群：挑一种光、叫上 AI，建好就进群', async () => {
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'POST' && path === '/conversation/v1/groups' ? json(201, group()) : undefined,
    });
    const router = await open('/groups#create-group');
    const dialog = await screen.findByRole('dialog', { name: '拉个新群' });
    expect(dialog.getAttribute('data-light')).toBe('mint');
    fireEvent.click(within(dialog).getByRole('radio', { name: '蜂蜜' }));
    expect(dialog.getAttribute('data-light')).toBe('honey');
    // 只列能聊天的对话 AI：没接入的、生图的型号不在里面
    const claude = await within(dialog).findByRole('checkbox', { name: 'Claude' });
    expect(within(dialog).queryByRole('checkbox', { name: '文心' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: 'Seedream 5.0 Pro' })).toBeNull();
    fireEvent.click(claude);
    fireEvent.change(within(dialog).getByLabelText('群名'), { target: { value: '发布会' } });
    const create = within(dialog).getByRole('button', { name: '建群' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('你在群里的名字'), { target: { value: '我' } });
    fireEvent.click(create);
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path === '/conversation/v1/groups')?.body).toEqual({
        title: '发布会',
        displayName: '我',
        ais: ['claude'],
        light: 'honey',
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/groups/${id}`));
  });
  it('推送被服务端拒了（比如服务正在重启）：隔一会儿自己重新连，从手上最后一条之后接着要', async () => {
    installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'GET' && path.endsWith(`/v1/groups/${id}`) ? json(200, group()) : undefined,
    });
    const stream = await room();
    act(() => stream.fail());
    await waitFor(() => expect(Stream.instances).toHaveLength(2), { timeout: 3000 });
    expect(Stream.instances[1]!.url).toContain(`/v1/groups/${id}/events?after=1`);
    act(() =>
      push(Stream.instances[1]!, group({ messages: [said(2, friend, '阿杰', '改到周六')] })),
    );
    expect(await screen.findByText('改到周六')).toBeTruthy();
    expect(screen.getByText('场地定在 B 栋天台')).toBeTruthy();
  });
});
