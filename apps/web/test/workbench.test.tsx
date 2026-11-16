// 群页的工作台：收起的一条、展开后的文件 / 预览 / 任务三个页签；聊天里的文件点开在工作台看，
// 干活的过程在任务卡上看；输入框的「＋」上传、引用群文件；和好友的私聊能发文件。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HISTORY_NOTICE, type GroupMessage } from '@oasis/contracts/group';
import { createApp } from '../src/app.tsx';
import { tasksOf } from '../src/group/workbench/tasks.ts';
import { installFakeApi, json, type ExtraRoute } from './fake-api.ts';
import { Stream } from './group-stream.ts';

const id = '00000000-0000-4000-8000-000000000061',
  me = '00000000-0000-4000-8000-000000000001',
  friend = '00000000-0000-4000-8000-000000000002',
  run = '00000000-0000-4000-8000-000000000071',
  oldRun = '00000000-0000-4000-8000-000000000072';
const at = '2026-11-16T02:00:00Z';
const uuid = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const base = (seq: number, authorId: string, role: 'user' | 'assistant') => ({
  id: `00000000-0000-4000-8000-0000000001${String(seq).padStart(2, '0')}`,
  seq,
  authorId,
  displayName: authorId === 'claude' ? 'Claude' : authorId === me ? '我' : '阿杰',
  role,
  status: 'complete',
  error: null,
  createdAt: at,
});
const said = (seq: number, authorId: string, content: string, data = {}) =>
  ({ ...base(seq, authorId, 'user'), content, kind: 'text', data }) as GroupMessage;
const step = (n: string, status = 'done') => ({
  type: 'step' as const,
  id: n,
  tool: 'bash',
  label: `第 ${n} 步`,
  status,
});
const aiSays = (seq: number, runId: string, parts: object[], patch = {}) =>
  ({
    ...base(seq, 'claude', 'assistant'),
    content: '',
    kind: 'text',
    data: { runId, parts, title: '排发布会流程' },
    ...patch,
  }) as GroupMessage;
const card = (seq: number, runId: string, data = {}) =>
  ({
    ...base(seq, 'claude', 'assistant'),
    content: '任务结束',
    kind: 'task',
    data: {
      runId,
      title: '排发布会流程',
      status: 'done',
      startedAt: at,
      finishedAt: '2026-11-16T02:03:00Z',
      spentMicro: 1200,
      files: [
        { artifactId: uuid(1), name: '流程.md', path: '流程.md', size: 2048, category: 'doc' },
      ],
      ...data,
    },
  }) as GroupMessage;
const file = (n: number, path: string, patch = {}) => ({
  id: uuid(n),
  path,
  name: path.split('/').at(-1),
  size: 2048,
  madeBy: { kind: 'ai', id: 'claude' },
  changedBy: { kind: 'ai', id: 'claude' },
  runId: null,
  updatedAt: at,
  ...patch,
});
const group = (patch = {}) => ({
  id,
  kind: 'group',
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
  ais: [{ key: 'claude', role: '', runId: null, startedAt: null, callers: [], heardSeq: 0 }],
  messages: [] as GroupMessage[],
  filesRev: 1,
  ...patch,
});
const FILES = [
  file(1, '流程.md'),
  file(2, '嘉宾名单.csv', {
    madeBy: { kind: 'user', id: friend },
    changedBy: { kind: 'ai', id: 'claude' },
  }),
];
/** 假后端：群文件、工作台要的消息，其余交给测试 */
const api = (work: GroupMessage[] = [], extra?: ExtraRoute) =>
  installFakeApi({
    signedIn: true,
    extra: (method, path, body) => {
      const custom = extra?.(method, path, body);
      if (custom) return custom;
      if (method === 'GET' && path.endsWith('/files')) return json(200, { files: FILES });
      if (method === 'GET' && path.endsWith('/work')) return json(200, { messages: work });
      if (path.includes('/content')) return new Response('# 流程\n\n19:00 签到');
      return undefined;
    },
  });
async function room(snapshot: unknown, path = `/groups/${id}`) {
  vi.stubGlobal('EventSource', Stream);
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
  await waitFor(() => expect(Stream.instances).toHaveLength(1));
  act(() => Stream.instances[0]!.emit({ type: 'snapshot', snapshot }));
}
afterEach(() => {
  vi.unstubAllGlobals();
  Stream.instances = [];
  localStorage.clear();
});

describe('工作台上的任务是怎么从消息里拼出来的', () => {
  it('动过手的一轮是一张卡：在做的在「进行中」，做完的在「完成」；只聊天的一轮不算', () => {
    const tasks = tasksOf([
      aiSays(1, oldRun, [{ type: 'text', text: '好' }, step('1'), step('2')]),
      card(2, oldRun),
      aiSays(3, uuid(9), [{ type: 'text', text: '你好呀' }]),
      aiSays(4, run, [step('1'), step('2', 'running')], {
        status: 'streaming',
        data: {
          runId: run,
          title: '算预算',
          parts: [step('1'), step('2', 'running')],
          todos: [
            { text: '场地', status: 'done' },
            { text: '茶歇', status: 'doing' },
          ],
        },
      }),
    ]);
    expect(tasks.map((task) => [task.title, task.column, task.note])).toEqual([
      ['算预算', 'doing', '第 2 步'],
      ['排发布会流程', 'done', '做了 2 步，交了 1 个文件'],
    ]);
    expect(tasks[0]).toMatchObject({ percent: 50, live: true });
    expect(tasks[1]!.parts).toHaveLength(3);
  });

  it('它最新的话里有没答的问卷、出错了、停下了：在「等你确认」；后面又说了话的旧任务算完成', () => {
    const question =
      '```oasis-questions\n{"questions":[{"id":"a","text":"抽奖放哪","options":["开头","结尾"]}]}\n```';
    const asking = tasksOf([aiSays(1, run, [], { content: question })]);
    expect(asking.map((task) => [task.column, task.note])).toEqual([
      ['review', '在等人回答它的问题'],
    ]);
    const failed = aiSays(1, oldRun, [step('1')], { status: 'failed' });
    expect(tasksOf([failed])[0]).toMatchObject({ column: 'review', note: '出错了，可以让它继续' });
    // 之后它又开了一轮：旧的那轮不再等人
    const later = tasksOf([failed, aiSays(2, run, [step('1')])]);
    expect(later.map((task) => [task.column, task.note])).toEqual([
      ['done', '做了 1 步'],
      ['done', '出错了'],
    ]);
  });
});

describe('工作台', () => {
  it('收起时是一条；展开后「文件」里一格一个，写着谁做的谁改过；点开在「预览」里看，能发到群里', async () => {
    const state = api();
    await room(group());
    const rail = screen.getByRole('region', { name: '工作台（收起）' });
    fireEvent.click(within(rail).getByRole('button', { name: '展开工作台' }));
    const bench = screen.getByRole('region', { name: '工作台' });
    const files = await within(bench).findByRole('list', { name: '群文件' });
    expect(within(files).getAllByRole('listitem')).toHaveLength(2);
    expect(within(files).getByText(/^Claude 做的，/)).toBeTruthy();
    expect(within(files).getByText('阿杰 传的，Claude 改过')).toBeTruthy();
    fireEvent.click(within(files).getByRole('button', { name: /^流程\.md/ }));
    // 换到「预览」：上面一排是打开的文件，下面是内容
    expect(within(bench).getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const preview = within(bench).getByRole('article', { name: '预览 流程.md' });
    expect(await within(preview).findByText('19:00 签到')).toBeTruthy();
    expect(state.requests.some((r) => r.includes(`/files/${uuid(1)}/content`))).toBe(true);
    // 「发到群里」：引用进输入框；发出去的话带着它
    fireEvent.click(within(preview).getByRole('button', { name: '发到群里' }));
    expect(
      within(screen.getByRole('list', { name: '引用的群文件' })).getByText('流程.md'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/messages'))?.body).toMatchObject({
        content: '',
        refs: ['流程.md'],
        attachments: [],
      }),
    );
    // 群主能删；展开还是收起记在本地
    expect(within(preview).getByRole('button', { name: '删除' })).toBeTruthy();
    expect(localStorage.getItem('oasis.workbench')).toBe('open');
    fireEvent.click(within(bench).getByRole('button', { name: '拉宽工作台' }));
    expect(within(bench).getByRole('button', { name: '恢复工作台宽度' })).toBeTruthy();
    fireEvent.click(within(bench).getByRole('button', { name: '收起工作台' }));
    expect(screen.getByRole('region', { name: '工作台（收起）' })).toBeTruthy();
  });

  it('聊天里不放过程：点「正在干活」那一行去「任务」看这一轮的步骤和待办；任务卡上的文件点开预览', async () => {
    const working = aiSays(
      3,
      run,
      [{ type: 'text', text: '好，我来算。' }, step('1'), step('2', 'running')],
      {
        status: 'streaming',
      },
    );
    api([
      aiSays(1, oldRun, [step('1'), { type: 'text', text: '边做边说的话' }, step('2')]),
      card(2, oldRun),
    ]);
    await room(
      group({
        ais: [{ key: 'claude', role: '', runId: run, startedAt: at, callers: [me], heardSeq: 0 }],
        messages: [card(2, oldRun), working],
      }),
    );
    // 聊天里：任务卡、它开工前说的话、一行「做到第几步」；没有步骤
    const log = screen.getByRole('log', { name: '群消息记录' });
    expect(within(log).queryByText('第 1 步')).toBeNull();
    fireEvent.click(await within(log).findByRole('button', { name: /正在干活，做到第 2 步/ }));
    const bench = screen.getByRole('region', { name: '工作台' });
    expect(within(bench).getByRole('tab', { name: '任务' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const doing = within(bench).getByRole('region', { name: '进行中' });
    expect(within(doing).getByRole('article', { name: 'Claude：排发布会流程' })).toBeTruthy();
    const done = await within(bench).findByRole('region', { name: '完成' });
    await waitFor(() => expect(within(done).getAllByRole('article')).toHaveLength(1));
    // 展开的是点的那一轮：两步，第二步还在做；能停下
    const process = within(bench).getByRole('region', { name: 'Claude 的过程' });
    expect(within(process).getAllByText(/第 \d 步/)).toHaveLength(2);
    expect(within(process).getByRole('button', { name: '停下' })).toBeTruthy();
    // 点做完的那张：过程里有边做边说的话
    fireEvent.click(within(done).getByRole('button', { expanded: false }));
    expect(
      within(within(bench).getByRole('region', { name: 'Claude 的过程' })).getByText(
        '边做边说的话',
      ),
    ).toBeTruthy();
    // 聊天里任务卡上的文件：点开在工作台预览；「看过程」回到任务
    fireEvent.click(within(log).getByRole('button', { name: '在工作台打开 流程.md' }));
    expect(await within(bench).findByRole('article', { name: '预览 流程.md' })).toBeTruthy();
    fireEvent.click(within(log).getByRole('button', { name: '看过程' }));
    expect(within(bench).getByRole('region', { name: 'Claude 的过程' })).toBeTruthy();
    // 输入框上面那一行也能去工作台
    expect(screen.getByRole('button', { name: /1 个 AI 在工作台忙/ })).toBeTruthy();
  });

  it('「＋」：引用工作台里的文件、上传文件；别人发的文件在话下面，点开在工作台看', async () => {
    // 上传走 XHR（要进度）：假的一个，交上去马上传完
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        upload = { onprogress: null };
        onload: (() => void) | null = null;
        status = 201;
        responseText = JSON.stringify({
          id: uuid(7),
          name: '平面图.png',
          size: 3,
          contentType: 'image/png',
          createdAt: at,
        });
        open() {}
        setRequestHeader() {}
        send() {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const state = api();
    await room(
      group({
        messages: [
          said(1, friend, '', {
            attachments: [{ id: uuid(8), name: '嘉宾名单.csv', size: 9, contentType: 'text/csv' }],
          }),
          said(2, friend, '看这个', { refs: [{ path: '没了.txt', name: '没了.txt' }] }),
        ],
      }),
    );
    const log = screen.getByRole('log', { name: '群消息记录' });
    // 只发了文件的那句没有空气泡；文件还在群文件里的能点开，不在了的点不了
    expect(
      await within(log).findByRole('button', { name: '在工作台打开 嘉宾名单.csv' }),
    ).toBeTruthy();
    expect(
      (
        within(log).getByRole('button', {
          name: /没了\.txt（已经不在群文件里）/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    const menu = screen.getByRole('menu', { name: '更多' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: '引用工作台里的文件' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^流程\.md/ }));
    expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    // 上传：选中就传，传完才能发
    const picked = new File(['png'], '平面图.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('选择要发的文件'), { target: { files: [picked] } });
    expect(
      within(screen.getByRole('list', { name: '要发送的文件' })).getByText('平面图.png'),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/messages'))?.body).toMatchObject({
        refs: ['流程.md'],
        attachments: [uuid(7)],
      }),
    );
  });

  it('和好友的私聊：没有工作台和「@」，「＋」就是发文件；对方发的文件点开弹出预览', async () => {
    api();
    await room(
      group({
        kind: 'direct',
        title: '阿杰',
        aiCount: 0,
        ais: [],
        filesRev: 0,
        messages: [
          said(1, friend, '合照', {
            attachments: [{ id: uuid(8), name: '合照.txt', size: 9, contentType: 'text/plain' }],
          }),
        ],
      }),
      `/chats/${id}`,
    );
    expect(await screen.findByText('合照')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /工作台/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '召唤某个 AI 或某人' })).toBeNull();
    expect(screen.getByRole('button', { name: '发文件' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '预览 合照.txt' }));
    // 预览读的是这条消息带的那份文件
    const dialog = await waitFor(() => {
      const found = document.querySelector('dialog[aria-label="预览 合照.txt"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.querySelector('a[download]')?.getAttribute('href')).toBe(
      `/api/conversation/v1/groups/${id}/attachments/${uuid(8)}/content?download=1`,
    );
  });
});
