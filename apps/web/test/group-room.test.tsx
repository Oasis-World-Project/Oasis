// 群页里的 AI：舞台、@ 谁谁回、AI 正在写的话原地换新、它忙着时「现在告诉它」、拉群时选光、AI 和好友。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, profileOf } from './fake-api.ts';
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
  options: { light: 'coral', speak: 'mention' },
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
    await room(group({ light: 'mint', options: { light: 'mint', speak: 'mention' } }));
    expect(screen.getByRole('heading', { name: '周五发布会筹备' })).not.toBeNull();
    expect(screen.getByText('2 个人和 1 个 AI')).not.toBeNull();
    expect(document.querySelector('.oasis-room')?.getAttribute('data-light')).toBe('mint');
    // 消息区是定位基准：问卷卡里视觉隐藏的单选框跟着它滚，选的时候不会把整页滚走
    expect(screen.getByRole('log', { name: '消息记录' }).parentElement?.className).toContain(
      'relative',
    );
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
      friends: {
        friends: [{ profile: profileOf(friend, '阿杰'), since: at, chatId: null }],
        incoming: [],
        outgoing: [],
      },
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
    const create = within(dialog).getByRole('button', { name: '建群' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('群名'), { target: { value: '发布会' } });
    // 好友一起拉进来（不用对方同意）
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: '阿杰' }));
    fireEvent.click(create);
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path === '/conversation/v1/groups')?.body).toEqual({
        title: '发布会',
        ais: ['claude'],
        members: [friend],
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
  it('干活的过程在群聊里收成一行：开工前和收工后说的话在外面，步骤和边做边说的话点开才看；群主能换成「看情况」', async () => {
    const step = (id: string, status: string) => ({
      type: 'step',
      id,
      tool: 'bash',
      label: `第 ${id} 步`,
      status,
    });
    const parts = [
      { type: 'text', text: '好，我来做海报。' },
      step('1', 'done'),
      { type: 'text', text: '先看看素材' },
      step('2', 'done'),
    ];
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'PUT' && path.endsWith('/options') ? json(200, group()) : undefined,
    });
    const stream = await room(
      group({
        messages: [writing(2, { content: '好，我来做海报。', data: { runId: run, parts } })],
      }),
    );
    expect(await screen.findByText('好，我来做海报。')).toBeTruthy();
    const fold = screen.getByText('做到 2 步').closest('details')!;
    expect(fold.open).toBe(false);
    expect(fold.contains(screen.getByText('先看看素材'))).toBe(true);
    act(() =>
      push(stream, {
        ...group(),
        messages: [],
        live: [
          writing(2, {
            status: 'complete',
            data: { runId: run, parts: [...parts, { type: 'text', text: '海报做好了。' }] },
          }),
        ],
      }),
    );
    expect(await screen.findByText('海报做好了。')).toBeTruthy();
    expect(screen.getByText('做了 2 步').closest('details')!.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '群设置' }));
    fireEvent.click(screen.getByText('看情况'));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/options'))?.body).toEqual({
        speak: 'auto',
      }),
    );
  });

  it('金库：页头上是现在有多少；空了时输入框上面提示一句；点开能看每个人存了、花了多少，从钱包存入', async () => {
    let vault = {
      availableMicro: 0,
      depositedMicro: 3_000_000,
      spentMicro: 3_000_000,
      members: [{ userId: friend, depositedMicro: 3_000_000, spentMicro: 3_000_000 }],
    };
    const state = installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (path === `/conversation/v1/groups/${id}/vault`) return json(200, vault);
        if (method !== 'POST' || !path.endsWith('/vault/deposits')) return undefined;
        vault = { ...vault, availableMicro: 10_000_000, depositedMicro: 13_000_000 };
        vault.members = [
          ...vault.members,
          { userId: me, depositedMicro: 10_000_000, spentMicro: 0 },
        ];
        return json(200, vault);
      },
    });
    await room();
    expect(await screen.findByRole('button', { name: '金库，现在有 $0.00' })).not.toBeNull();
    const empty = screen.getByRole('status');
    expect(empty.textContent).toContain('金库空了。存入后群里的 AI 才能用。');
    fireEvent.click(within(empty).getByRole('button', { name: '存入' }));
    const dialog = screen.getByRole('dialog', { name: '金库' });
    expect(within(dialog).getByText('一共存入 $3.00，花了 $3.00')).not.toBeNull();
    expect(within(dialog).getByText('从我的钱包存入（钱包里有 $30.00）')).not.toBeNull();
    const rows = () =>
      within(dialog)
        .getAllByRole('row')
        .map((row) => row.textContent);
    expect(rows()).toEqual(['我我存入 $0.00花了 $0.00', '阿阿杰存入 $3.00花了 $3.00']);
    // 默认存 $10
    expect(within(dialog).getByRole('radio', { name: '$10' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '存入 $10' }));
    await waitFor(() => expect(rows()[0]).toBe('我我存入 $10.00花了 $0.00'));
    expect(state.bodies.at(-1)).toEqual({
      path: `/conversation/v1/groups/${id}/vault/deposits`,
      body: { amountMicro: 10_000_000 },
    });
    // 有钱了：页头换成新的数，提示收起
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog', { name: '金库' })).toBeNull();
    expect(screen.getByRole('button', { name: '金库，现在有 $10.00' })).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
