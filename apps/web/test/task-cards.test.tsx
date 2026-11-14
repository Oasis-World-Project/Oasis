// 私聊里的一轮：AI 说的话和步骤、待办、问卷卡和任务单卡（AI 回复里的代码块）、任务卡、插话、
// 要改的成果、开新话题、删私聊。
import type { MessageBody, TurnState } from '@oasis/contracts/conversation';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, type ExtraRoute } from './fake-api.ts';

const NOW = '2026-11-14T08:00:00.000Z';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const PATH = `/conversation/v1/conversations/${CONV}/messages`;
const TURN: TurnState = { runId: RUN, startedAt: NOW, confirmations: [] };

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
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function message(
  kind: MessageBody['kind'],
  data: object,
  role: 'user' | 'assistant' = 'assistant',
  content = '',
  status: MessageBody['status'] = 'complete',
): MessageBody {
  return {
    id: nextId(),
    role,
    content,
    status,
    error: null,
    createdAt: NOW,
    kind,
    data,
  } as MessageBody;
}
const user = (content: string, data: object = {}) =>
  message('text', { runId: RUN, ...data }, 'user', content);
/** AI 在这一轮里的一段话：按顺序的话、步骤、提示 */
const ai = (parts: object[], data: object = {}, status: MessageBody['status'] = 'complete') =>
  message('text', { runId: RUN, parts, ...data }, 'assistant', '', status);
const say = (text: string) => ({ type: 'text', text });

/** 一个私聊的假后端：消息和正在进行的一轮都能在测试里改；发的话接在后面 */
function fakeChat(initial: MessageBody[], options: { turn?: TurnState; extra?: ExtraRoute } = {}) {
  const chat = { messages: [...initial], turn: options.turn ?? null };
  const api = installFakeApi({
    signedIn: true,
    dms: [DM],
    extra: (method, path, body) => {
      const custom = options.extra?.(method, path, body);
      if (custom) return custom;
      if (method === 'GET' && path === PATH)
        return json(200, { messages: chat.messages, turn: chat.turn });
      if (method === 'POST' && path === PATH) {
        const sent = user((body as { content: string }).content);
        chat.messages = [...chat.messages, sent];
        return json(201, { messages: [sent], turn: chat.turn });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI 在一轮里说的话和做的事', () => {
  it('按顺序显示：话（Markdown）、步骤（默认折叠，显示正在做的一步）、系统提示、待办', async () => {
    fakeChat(
      [
        user('做个网页'),
        ai(
          [
            say('好的，**先写页面**'),
            {
              type: 'step',
              id: 'c1',
              tool: 'write',
              label: '写文件 out/index.html',
              status: 'done',
            },
            {
              type: 'step',
              id: 'c2',
              tool: 'bash',
              label: '运行命令：npm test',
              status: 'running',
            },
            { type: 'notice', text: '服务恢复了，接着做' },
          ],
          {
            todos: [
              { text: '写页面', status: 'done' },
              { text: '测一遍', status: 'doing' },
            ],
          },
          'streaming',
        ),
      ],
      { turn: TURN },
    );
    await openChat();
    expect((await screen.findByText('先写页面')).tagName).toBe('STRONG');
    const steps = screen.getByRole('list', { name: '步骤', hidden: true });
    const summary = steps.closest('details')!.querySelector('summary')!;
    expect(summary.textContent).toContain('运行命令：npm test');
    expect(within(steps).getAllByRole('listitem', { hidden: true })).toHaveLength(2);
    expect(screen.getByText('服务恢复了，接着做')).toBeTruthy();
    expect(screen.getByText('待办 1/2')).toBeTruthy();
    // 一轮在做：输入框照样能发（先排着），旁边有停止按钮
    expect(screen.getByPlaceholderText('AI 正在做，发的话先排着，做完接着做…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '停下这一轮' })).toBeTruthy();
  });

  it('做完：步骤说一共做了几步、几步没成；写上这一轮的花费；只是聊天时没有任务卡', async () => {
    fakeChat([
      user('你好'),
      ai(
        [
          say('你好！'),
          { type: 'step', id: 'c1', tool: 'bash', label: '运行命令：ls', status: 'done' },
          {
            type: 'step',
            id: 'c2',
            tool: 'bash',
            label: '运行命令：npm test',
            status: 'failed',
            detail: '测试没过',
          },
        ],
        { spentMicro: 12_345 },
      ),
    ]);
    await openChat();
    expect(await screen.findByText('做了 2 步，1 步没成')).toBeTruthy();
    expect(screen.getByText('测试没过')).toBeTruthy();
    expect(screen.getByText('这一轮花了 $0.0123')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停下这一轮' })).toBeNull();
  });
});

describe('问卷卡和任务单卡', () => {
  const QUESTIONS = {
    questions: [
      { id: 'q1', text: '给谁看？', options: ['游客', '合作方'] },
      { id: 'q2', text: '什么风格？', options: ['温馨', '简洁'] },
    ],
  };
  const asked = () =>
    ai([say(`先问两件事。\n\n\`\`\`oasis-questions\n${JSON.stringify(QUESTIONS)}\n\`\`\``)]);

  it('问卷：每题选一个再发，可以自己写；回答作为一条普通消息发出，之后问卷只显示内容', async () => {
    const { api } = fakeChat([user('做个首页'), asked()]);
    await openChat();
    const card = await screen.findByRole('region', { name: '问卷' });
    expect(screen.getByText('先问两件事。')).toBeTruthy();
    const send = within(card).getByRole('button', { name: '发送回答' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole('radio', { name: '游客' }));
    fireEvent.click(
      within(within(card).getByRole('group', { name: '什么风格？' })).getByRole('radio', {
        name: '自己写',
      }),
    );
    fireEvent.change(within(card).getByLabelText('什么风格？：自己写'), {
      target: { value: '复古' },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.bodies.find((b) => b.path === PATH)?.body).toEqual({
        content: '1. 给谁看？——游客\n2. 什么风格？——复古',
        attachments: [],
      }),
    );
    await waitFor(() =>
      expect(within(card).queryByRole('button', { name: '发送回答' })).toBeNull(),
    );
    expect(within(card).getByText('游客 / 合作方')).toBeTruthy();
  });

  it('格式不对的代码块照原样当文字显示', async () => {
    fakeChat([ai([say('```oasis-questions\n{不是 JSON}\n```')])]);
    await openChat();
    expect(await screen.findByText('{不是 JSON}')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '问卷' })).toBeNull();
  });

  it('任务单：确认发一句「确认，开始做」；「要改一下」把焦点给输入框并换提示', async () => {
    const plan = {
      title: '开业视频',
      steps: ['写分镜', '一起生成 3 张关键帧'],
      estimate: '约 $1.5、20 分钟',
    };
    const { api } = fakeChat([
      user('做个开业视频'),
      ai([say(`\`\`\`oasis-plan\n${JSON.stringify(plan)}\n\`\`\``)]),
    ]);
    await openChat();
    const card = await screen.findByRole('region', { name: '任务单' });
    expect(within(card).getByRole('heading', { name: '开业视频' })).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).getByText('预计 约 $1.5、20 分钟')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '要改一下' }));
    expect(screen.getByPlaceholderText('说说要改哪里，比如：分镜改成 4 个')).toBe(
      document.activeElement,
    );
    fireEvent.click(within(card).getByRole('button', { name: '确认，开始做' }));
    await waitFor(() =>
      expect(api.bodies.find((b) => b.path === PATH)?.body).toEqual({
        content: '确认，开始做',
        attachments: [],
      }),
    );
  });
});

describe('任务卡', () => {
  it('进行中：显示用时和花费，可以停下', async () => {
    const card = message('task', {
      runId: RUN,
      status: 'running',
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      finishedAt: null,
      spentMicro: 40_000,
      files: [],
    });
    const { api } = fakeChat([user('画一只猫'), ai([], {}, 'streaming'), card], {
      turn: TURN,
      extra: (method, path) =>
        method === 'POST' && path === `/conversation/v1/conversations/${CONV}/stop`
          ? new Response(null, { status: 204 })
          : undefined,
    });
    await openChat();
    const region = await screen.findByRole('region', { name: '任务' });
    expect(within(region).getByText('进行中')).toBeTruthy();
    expect(region.textContent).toMatch(/用时 1 分 \d+ 秒/);
    expect(region.textContent).toContain('$0.0400');
    fireEvent.click(within(region).getByRole('button', { name: '停下' }));
    await waitFor(() =>
      expect(api.requests).toContain(`POST /conversation/v1/conversations/${CONV}/stop`),
    );
  });

  it('做完：写上任务名、用时、花费和成品（素材只说几个）；成品能预览、下载，能去画布看这个私聊的成果', async () => {
    const PAGE = '00000000-0000-4000-8000-0000000000d1';
    const card = message('task', {
      runId: RUN,
      title: '民宿首页',
      status: 'done',
      startedAt: '2026-11-14T08:00:00.000Z',
      finishedAt: '2026-11-14T08:03:20.000Z',
      spentMicro: 120_000,
      files: [
        {
          artifactId: PAGE,
          name: 'index.html',
          path: 'site/index.html',
          size: 2048,
          category: 'app',
        },
        {
          artifactId: '00000000-0000-4000-8000-0000000000d2',
          name: '首屏.png',
          path: '素材/首屏.png',
          size: 4096,
          category: 'doc',
        },
      ],
    });
    fakeChat([user('做个网页'), ai([say('做好了')], { spentMicro: 120_000 }), card]);
    await openChat();
    const region = await screen.findByRole('region', { name: '任务' });
    expect(within(region).getByRole('heading', { name: '民宿首页' })).toBeTruthy();
    expect(within(region).getByText('已完成')).toBeTruthy();
    expect(region.textContent).toContain('用时 3 分 20 秒');
    expect(region.textContent).toContain('素材 1 个');
    expect(within(region).queryByRole('button', { name: '预览 首屏.png' })).toBeNull();
    expect(within(region).getByRole('link', { name: '下载 index.html' }).getAttribute('href')).toBe(
      `/api/canvas/v1/artifacts/${PAGE}/content?download=1`,
    );
    expect(
      within(region)
        .getByRole('link', { name: /在画布里看/ })
        .getAttribute('href'),
    ).toBe(`/canvas?conversation=${CONV}`);
    expect(
      within(region)
        .getByRole('link', { name: /看进度/ })
        .getAttribute('href'),
    ).toBe(`/canvas/runs/${RUN}?conversation=${CONV}`);
    expect(within(region).queryByRole('button', { name: '停下' })).toBeNull();
  });
});

describe('用户的话', () => {
  it('插话有标记；要改的成果链到画布；很长的话只显示开头', async () => {
    const ARTIFACT = '00000000-0000-4000-8000-0000000000d2';
    const text = '很长的修改意见。'.repeat(100) + '正文末尾';
    fakeChat([
      user('做个视频'),
      ai([say('先写分镜')]),
      user('改成竖屏', { interjection: true }),
      ai([say('好，改成竖屏')], {}, 'streaming'),
      user('配上字幕', { interjection: true }),
      user(text, { artifacts: [{ id: ARTIFACT, name: 'index.html', path: 'site/index.html' }] }),
    ]);
    await openChat();
    // AI 看到了的插话后面接着它的话；还没看到的（前面那段还在写）标明它做完手上这一步就看到
    expect(await screen.findByText('插话')).toBeTruthy();
    expect(screen.getByText('插话 · AI 做完手上这一步就会看到')).toBeTruthy();
    expect(screen.getByRole('link', { name: /要改：index\.html/ }).getAttribute('href')).toBe(
      `/canvas/artifacts/${ARTIFACT}`,
    );
    expect(screen.queryByText(/正文末尾/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /查看全文/ }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText(text)).toBeTruthy();
    // 没有编辑、重新生成、删除单条消息
    expect(screen.queryByRole('button', { name: /编辑消息|重新生成|删除消息/ })).toBeNull();
  });

  it('AI 干活时发的话排在输入框上面（照 Codex），不进聊天：可以引导（现在交给 AI）、改、删', async () => {
    const queued = (content: string) => message('text', { pending: true }, 'user', content);
    const [vertical, subtitles, typo] = [queued('改成竖屏'), queued('配上字幕'), queued('写错了')];
    const { chat, api } = fakeChat(
      [user('做个视频'), ai([say('先写分镜')], {}, 'streaming'), vertical, subtitles, typo],
      {
        turn: TURN,
        extra: (method, path) => {
          if (method === 'POST' && path === `${PATH}/${vertical.id}/steer`) {
            const steered = {
              ...vertical,
              data: { runId: RUN, interjection: true },
            } as MessageBody;
            chat.messages = [...chat.messages.filter((m) => m.id !== vertical.id), steered];
            return json(200, { messages: [steered], turn: TURN });
          }
          if (method === 'DELETE' && path.startsWith(`${PATH}/`)) {
            chat.messages = chat.messages.filter((m) => path !== `${PATH}/${m.id}`);
            return new Response(null, { status: 204 });
          }
          return undefined;
        },
      },
    );
    await openChat();
    const bar = await screen.findByRole('region', { name: '排着队的话' });
    expect(within(bar).getAllByRole('listitem')).toHaveLength(3);
    // 排着的话只在输入框上面，不在聊天里
    expect(screen.getAllByText('改成竖屏')).toHaveLength(1);
    expect(screen.getByPlaceholderText('AI 正在做，发的话先排着，做完接着做…')).toBeTruthy();
    // 引导：现在交给这一轮，进聊天、标成插话
    fireEvent.click(within(bar).getByRole('button', { name: '引导：改成竖屏' }));
    expect(await screen.findByText('插话 · AI 做完手上这一步就会看到')).toBeTruthy();
    expect(api.requests).toContain(`POST ${PATH}/${vertical.id}/steer`);
    await waitFor(() => expect(within(bar).getAllByRole('listitem')).toHaveLength(2));
    // 删掉
    fireEvent.click(within(bar).getByRole('button', { name: '删掉：写错了' }));
    await waitFor(() => expect(screen.queryByText('写错了')).toBeNull());
    expect(api.requests).toContain(`DELETE ${PATH}/${typo.id}`);
    // 改：从队里拿回输入框
    fireEvent.click(within(bar).getByRole('button', { name: '改：配上字幕' }));
    await waitFor(() =>
      expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('配上字幕'),
    );
    expect(api.requests).toContain(`DELETE ${PATH}/${subtitles.id}`);
    await waitFor(() => expect(screen.queryByRole('region', { name: '排着队的话' })).toBeNull());
  });
});

describe('开新话题、删私聊', () => {
  it('开新话题：问一句再开，聊天里出现分隔；一轮进行中不能开', async () => {
    const divider = message('topic', {}, 'user', '开了新话题');
    const { api } = fakeChat([user('你好'), ai([say('你好！')])], {
      extra: (method, path) =>
        method === 'POST' && path === `/conversation/v1/conversations/${CONV}/topics`
          ? json(201, { message: divider })
          : undefined,
    });
    await openChat();
    await screen.findByText('你好！');
    fireEvent.click(screen.getByRole('button', { name: '开新话题' }));
    const ask = screen.getByRole('group', { name: '开新话题？' });
    expect(ask.textContent).toContain('AI 会忘掉之前聊的');
    fireEvent.click(within(ask).getByRole('button', { name: '开新话题' }));
    expect(await screen.findByRole('separator')).toBeTruthy();
    expect(api.requests).toContain(`POST /conversation/v1/conversations/${CONV}/topics`);
  });

  it('一轮进行中「开新话题」不能点', async () => {
    fakeChat([user('做个网页'), ai([], {}, 'streaming')], { turn: TURN });
    await openChat();
    const button = await screen.findByRole('button', { name: '开新话题' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });

  it('删除私聊：问一句再删，删完回到私聊列表', async () => {
    const { api } = fakeChat([user('在吗')], {
      extra: (method, path) =>
        method === 'DELETE' && path === `/conversation/v1/conversations/${CONV}`
          ? new Response(null, { status: 204 })
          : undefined,
    });
    await openChat();
    fireEvent.click(await screen.findByRole('button', { name: '删除私聊' }));
    const ask = screen.getByRole('group', { name: '删除这段私聊？' });
    expect(ask.textContent).toContain('聊天、成果和 AI 的记忆都删掉');
    fireEvent.click(within(ask).getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(api.requests).toContain(`DELETE /conversation/v1/conversations/${CONV}`),
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: '私聊' })).toBeNull());
  });
});
