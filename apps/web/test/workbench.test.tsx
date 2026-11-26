// 群页的工作台：收起的一条、展开后的文件 / 预览 / 任务三个页签；聊天里的文件点开在工作台看，
// 干活的过程在任务卡上看；输入框的「＋」上传、引用群文件；和好友的私聊能发文件。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_HISTORY_NOTICE, type GroupMessage } from '@oasis/contracts/group';
import { createApp } from '../src/app.tsx';
import { tasksOf } from '../src/group/workbench/tasks.ts';
import { installFakeApi, json, type ExtraRoute } from './fake-api.ts';
import {
  aiSays,
  at,
  card,
  file,
  friend,
  id,
  me,
  oldRun,
  plan,
  run,
  said,
  step,
  uuid,
} from './group-messages.ts';
import { Stream } from './group-stream.ts';

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
  options: { light: 'coral', speak: 'mention' },
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

  it('它最新的话里有没答的问卷：还在「进行中」，亮着在等人；出错了、停下了算「已完成」，还能让它继续；后面又说了话的旧任务不再能继续', () => {
    const question =
      '```oasis-questions\n{"questions":[{"id":"a","text":"抽奖放哪","options":["开头","结尾"]}]}\n```';
    const asking = tasksOf([aiSays(1, run, [], { content: question })]);
    expect(asking).toMatchObject([{ column: 'doing', note: '在等人回答它的问题', asking: true }]);
    const failed = aiSays(1, oldRun, [step('1')], { status: 'failed' });
    expect(tasksOf([failed])[0]).toMatchObject({
      column: 'done',
      note: '出错了，可以让它继续',
      resumable: true,
    });
    // 之后它又开了一轮：旧的那轮不再等人
    const later = tasksOf([failed, aiSays(2, run, [step('1')])]);
    expect(later.map((task) => [task.column, task.note, task.resumable])).toEqual([
      ['done', '做了 1 步', undefined],
      ['done', '出错了', undefined],
    ]);
  });

  it('让 AI 改一个做完的任务：前后几轮算同一条，改的时候在「修改中」，改完回「已完成」；在等确认时亮红点', () => {
    const first = aiSays(1, oldRun, [step('1')]);
    const fixing = aiSays(3, run, [step('1', 'running')], { status: 'streaming' });
    const revised = (status: 'running' | 'done', extra: object = {}) => {
      const base = card(2, run);
      return {
        ...base,
        data: { ...base.data, status, runs: [oldRun, run], revision: 1, ...extra },
      } as GroupMessage;
    };
    const during = tasksOf([first, revised('running', { asking: true }), fixing]);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ column: 'fixing', asking: true, note: '在等确认' });
    expect(during[0]?.parts).toHaveLength(2);
    const after = tasksOf([first, revised('done'), aiSays(3, run, [step('1')])]);
    expect(after.map((task) => task.column)).toEqual(['done']);
  });
});

describe('分工单在工作台和聊天里', () => {
  it('还没开工的每一项是「待开始」里的一张卡；已经开工、有过程可看的那一项不重复出卡；没接的写明原因', () => {
    const tasks = tasksOf([
      plan(1, [
        {
          id: '3',
          key: 'kimi',
          task: '做海报',
          after: [],
          status: 'declined',
          runId: uuid(5),
          note: '不会画',
        },
      ]),
      { ...aiSays(2, run, [step('1', 'running')], { status: 'streaming' }), authorId: 'glm' },
    ]);
    expect(tasks.map((task) => [task.key, task.title, task.column, task.note])).toEqual([
      ['kimi', '做海报', 'done', '没接：不会画'],
      ['kimi', '写英文摘要', 'wait', '等第 1 项交了再开工'],
      ['glm', '排发布会流程', 'doing', '第 1 步'],
    ]);
  });

  it('聊天里是一张进度卡：交了几项、每项一个圆环；「看分工」去任务页签，「待开始」一栏有它；群主点开一项能改', async () => {
    const edits: unknown[] = [];
    api([], (method, path, body) => {
      if (method !== 'POST' || !path.endsWith(`/assigns/${plan(1).id}`)) return undefined;
      edits.push(body);
      return new Response(null, { status: 204 });
    });
    await room(group({ messages: [plan(1)] }));
    const progress = await screen.findByRole('region', { name: '任务进度' });
    expect(within(progress).getByText('0/2')).toBeTruthy();
    expect(within(progress).getByText('竞品 A 分析')).toBeTruthy();
    expect(within(progress).getByText('Claude 分了工')).toBeTruthy();
    expect(
      within(progress).getByRole('img', { name: /写英文摘要，等第 1 项交了再开工/ }),
    ).toBeTruthy();
    fireEvent.click(within(progress).getByRole('button', { name: '看分工' }));
    const bench = screen.getByRole('region', { name: '工作台' });
    const waiting = within(bench).getByRole('region', { name: '待开始' });
    expect(within(waiting).getByText('写英文摘要')).toBeTruthy();
    expect(
      within(within(bench).getByRole('region', { name: '进行中' })).getByText('做图表'),
    ).toBeTruthy();
    fireEvent.click(within(waiting).getByRole('button', { name: /写英文摘要/ }));
    const actions = within(screen.getByRole('dialog')).getByRole('group', { name: '改这一项' });
    expect(within(actions).getByRole('button', { name: '改要求' })).toBeTruthy();
    fireEvent.click(within(actions).getByRole('button', { name: '撤掉' }));
    await waitFor(() => expect(edits).toEqual([{ op: 'drop', item: '2' }]));
  });

  it('AI 话里的分工单代码块不显示（它另有一张卡），整块写在一行里也一样；不接的那一块显示成一句话', async () => {
    api();
    const fence = (kind: string, value: object) =>
      `\`\`\`oasis-${kind} ${JSON.stringify(value)} \`\`\``;
    const plan = {
      title: '竞品 A 分析',
      items: [{ id: '1', to: 'GLM', task: '做图表', after: [] }],
    };
    await room(
      group({
        messages: [
          aiSays(1, oldRun, [
            { type: 'text', text: `我来派： ${fence('assign', plan)} 等你们的结果。` },
          ]),
          {
            ...aiSays(2, run, [{ type: 'text', text: fence('decline', { reason: '没有数据' }) }]),
            authorId: 'glm',
          },
        ],
      }),
    );
    expect(await screen.findByText('我来派：')).toBeTruthy();
    expect(screen.getByText('等你们的结果。')).toBeTruthy();
    expect(screen.queryByText(/oasis-assign/)).toBeNull();
    expect(screen.getByText('这一项我不接：没有数据')).toBeTruthy();
  });

  it('「＋」里打开「作为任务发布」：输入框里有「任务」，发出去的话带着它；这句话下面写着挑了谁负责', async () => {
    const state = api();
    await room(
      group({
        messages: [said(1, friend, '做一份竞品分析', { task: true, lead: 'claude' })],
      }),
    );
    expect(await screen.findByText('任务 · 由 Claude 先出来负责')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /作为任务发布/ }));
    expect(
      screen.getByRole('menuitemcheckbox', { name: /作为任务发布/ }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), {
      target: { value: '做一个小游戏' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发布任务' }));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/messages'))?.body).toMatchObject({
        content: '做一个小游戏',
        task: true,
      }),
    );
  });
});

describe('工作台', () => {
  it('收起时是一条；展开后「文件」里只有大家自己传的，一格一个；点开在「预览」里看，能发到群里', async () => {
    const state = api();
    await room(group());
    const rail = screen.getByRole('region', { name: '工作台（收起）' });
    fireEvent.click(within(rail).getByRole('button', { name: '展开工作台' }));
    const bench = screen.getByRole('region', { name: '工作台' });
    fireEvent.click(within(bench).getByRole('tab', { name: '文件' }));
    // AI 做的（流程.md）不在这里，在任务里找
    const files = await within(bench).findByRole('list', { name: '群文件' });
    expect(within(files).getAllByRole('listitem')).toHaveLength(1);
    expect(within(files).getByText('阿杰 传的，Claude 改过')).toBeTruthy();
    fireEvent.click(within(files).getByRole('button', { name: /^嘉宾名单\.csv/ }));
    // 换到「预览」：上面一排是打开的文件，下面是内容
    expect(within(bench).getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const preview = within(bench).getByRole('article', { name: '预览 嘉宾名单.csv' });
    await waitFor(() =>
      expect(state.requests.some((r) => r.includes(`/files/${uuid(2)}/content`))).toBe(true),
    );
    // 「发到群里」：引用进输入框；发出去的话带着它
    fireEvent.click(within(preview).getByRole('button', { name: '发到群里' }));
    expect(
      within(screen.getByRole('list', { name: '引用的群文件' })).getByText('嘉宾名单.csv'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(state.bodies.find((b) => b.path.endsWith('/messages'))?.body).toMatchObject({
        content: '',
        refs: ['嘉宾名单.csv'],
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

  it('过程、任务只画一处：聊天里过程收成一行，任务是一条（和工作台里同一条），点开弹出它的窗；交的文件点开预览', async () => {
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
    // 聊天里：它开工前说的话、收成一行的过程（点开才看得到步骤）
    const log = screen.getByRole('log', { name: '消息记录' });
    const steps = await within(log).findByRole('list', { name: '步骤', hidden: true });
    expect(steps.closest('details')!.open).toBe(false);
    // 聊天里的任务就是工作台上那一条：点开弹出它的窗，过程里有边做边说的话
    fireEvent.click(within(log).getByRole('button', { name: 'Claude：排发布会流程' }));
    const finished = screen.getByRole('dialog', { name: '排发布会流程' });
    expect(await within(finished).findByText('边做边说的话')).toBeTruthy();
    fireEvent.click(within(finished).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // 点开任务时工作台跟着展开到「任务」：在做的那一轮在「进行中」，点它弹出的窗里两步、第二步还在做，能停下
    const bench = screen.getByRole('region', { name: '工作台' });
    expect(within(bench).getByRole('tab', { name: '任务' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const done = within(bench).getByRole('region', { name: '已完成' });
    await waitFor(() => expect(within(done).getAllByRole('button')).toHaveLength(1));
    const doing = within(bench).getByRole('region', { name: '进行中' });
    fireEvent.click(within(doing).getByRole('button', { name: 'Claude：排发布会流程' }));
    const process = screen.getByRole('dialog', { name: '排发布会流程' });
    expect(within(process).getAllByText(/第 \d 步/)).toHaveLength(2);
    expect(within(process).getByRole('button', { name: '停下' })).toBeTruthy();
    fireEvent.click(within(process).getByRole('button', { name: '关闭' }));
    // 聊天里任务交的文件：点开在工作台预览
    fireEvent.click(within(log).getByRole('button', { name: '在工作台打开 流程.md' }));
    expect(await within(bench).findByRole('article', { name: '预览 流程.md' })).toBeTruthy();
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
    const log = screen.getByRole('log', { name: '消息记录' });
    // 只发了文件的那句没有空气泡；文件还在群文件里的能点开，不在了的点不了
    expect(
      await within(log).findByRole('button', { name: '在工作台打开 嘉宾名单.csv' }),
    ).toBeTruthy();
    expect(
      (
        within(log).getByRole('button', {
          name: /没了\.txt（已经不在了）/,
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
