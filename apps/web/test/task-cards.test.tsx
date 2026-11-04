// 私聊里的任务卡片（5.5a）：问题卡 → 任务单 → 任务卡 → 交付，以及「发任务」。
import type { MessageBody } from '@oasis/contracts/conversation';
import type { TaskBody } from '@oasis/contracts/task';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, type ExtraRoute } from './fake-api.ts';

const NOW = '2026-10-23T08:00:00.000Z';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const INTAKE = '00000000-0000-4000-8000-0000000000e1';
const TASK = '00000000-0000-4000-8000-0000000000f1';
const NODE_A = '00000000-0000-4000-8000-0000000000a1';
const NODE_B = '00000000-0000-4000-8000-0000000000a2';

const DM = {
  id: CONV,
  kind: 'dm',
  title: 'Claude',
  modelKey: 'claude',
  createdAt: NOW,
  lastMessageAt: NOW,
};

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function message(
  kind: MessageBody['kind'],
  data: object,
  role: 'user' | 'assistant' = 'assistant',
  content = '',
): MessageBody {
  return {
    id: nextId(),
    role,
    content,
    status: 'complete',
    error: null,
    createdAt: NOW,
    kind,
    data,
  } as MessageBody;
}

const SHEET = {
  title: '小木屋民宿官网首页',
  deliverables: [{ name: '首页文案', form: 'Markdown' }],
  criteria: ['有标题、卖点和预订方式'],
  style: ['温馨'],
  budgetMicro: null,
  assumptions: ['用 Markdown 写'],
  materials: [],
};

const QUESTIONS = {
  intakeId: INTAKE,
  round: 1,
  intro: '先确认两件事。',
  questions: [
    {
      id: 'q1',
      text: '给谁看？',
      options: [
        { id: 'a', label: '游客' },
        { id: 'b', label: '合作方' },
      ],
      default: 'a',
    },
    {
      id: 'q2',
      text: '什么风格？',
      options: [
        { id: 'a', label: '温馨' },
        { id: 'b', label: '简洁' },
      ],
      default: 'a',
    },
  ],
  answers: null,
};

function node(id: string, key: string, title: string, status: string) {
  return {
    id,
    key,
    title,
    kind: 'work',
    role: '',
    goal: title,
    model: 'deepseek/x',
    checks: [],
    expects: [],
    tools: [],
    discussion: null,
    status,
    attempts: 1,
    userNotes: [],
    reworks: 0,
    warning: null,
    summary: null,
    outputs: [],
    spentMicro: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function task(overrides: Partial<TaskBody> = {}): TaskBody {
  return {
    id: TASK,
    title: SHEET.title,
    brief: '',
    status: 'running',
    attention: null,
    estimateMicro: 30_000,
    spentMicro: 12_300,
    budgetLimitMicro: 90_000,
    sheet: SHEET,
    acceptance: null,
    deliverables: [{ name: '首页文案', form: 'Markdown', nodeId: NODE_A }],
    nodes: [
      node(NODE_A, 'write', '写文案', 'succeeded'),
      node(NODE_B, 'image', '出效果图', 'running'),
    ],
    edges: [],
    createdAt: NOW,
    finishedAt: null,
    ...overrides,
  } as TaskBody;
}

/** 一个私聊会话的假后端：消息列表和任务都能在测试里改 */
function fakeChat(
  initial: MessageBody[],
  handlers: { task?: () => TaskBody; extra?: ExtraRoute } = {},
) {
  const chat = { messages: [...initial] };
  const api = installFakeApi({
    signedIn: true,
    dms: [DM],
    extra: (method, path, body) => {
      if (method === 'GET' && path === `/conversation/v1/conversations/${CONV}/messages`)
        return json(200, { messages: chat.messages });
      if (method === 'GET' && path === `/task/v1/tasks/${TASK}` && handlers.task)
        return json(200, handlers.task());
      return handlers.extra?.(method, path, body);
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

describe('问题卡和任务单', () => {
  it('已回答但生成失败时可继续；失败消息不隐藏入口，重试沿用保存的答案', async () => {
    const questions = message('questions', { ...QUESTIONS, answers: { q1: 'b', q2: 'a' } });
    const failed = {
      ...message('text', {}),
      status: 'failed',
      error: '任务单生成失败',
    } as MessageBody;
    const sheet = message('sheet', {
      intakeId: INTAKE,
      intro: '',
      sheet: SHEET,
      status: 'open',
      taskId: null,
    });
    const { chat, api } = fakeChat([questions, failed], {
      extra: (method, path) => {
        if (method === 'POST' && path.endsWith('/intake/answers')) {
          chat.messages = [questions, failed, sheet];
          return json(200, { messages: [sheet] });
        }
      },
    });
    await openChat();
    const resume = await screen.findByRole('button', { name: '继续整理' });
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(resume);
    await screen.findByRole('region', { name: '任务单' });
    expect(screen.queryByRole('button', { name: '继续整理' })).toBeNull();
    expect(api.bodies.find((b) => b.path.endsWith('/intake/answers'))?.body).toEqual({
      messageId: questions.id,
      answers: { q1: 'b', q2: 'a' },
      skip: false,
    });
    expect(api.bodies.some((b) => b.path.endsWith('/intake/confirm'))).toBe(false);
  });
  it('选好答案提交 → 任务单 → 确认后出现「正在搭建工作流」的任务卡', async () => {
    const asked = message('text', {}, 'user', '帮我给小木屋民宿写个官网首页');
    const questions = message('questions', QUESTIONS);
    const sheet = message('sheet', {
      intakeId: INTAKE,
      intro: '整理好了：',
      sheet: SHEET,
      status: 'open',
      taskId: null,
    });
    const taskCard = message('task', { taskId: TASK });
    const { chat, api } = fakeChat([asked, questions], {
      task: () => task({ status: 'planning', nodes: [], spentMicro: 0, estimateMicro: null }),
      extra: (method, path) => {
        if (method === 'POST' && path.endsWith('/intake/answers')) {
          chat.messages = [
            asked,
            { ...questions, data: { ...QUESTIONS, answers: { q1: 'b', q2: 'a' } } } as MessageBody,
            sheet,
          ];
          return json(200, { messages: [sheet] });
        }
        if (method === 'POST' && path.endsWith('/intake/confirm')) {
          chat.messages = [
            ...chat.messages.slice(0, 2),
            { ...sheet, data: { ...sheet.data, status: 'confirmed', taskId: TASK } } as MessageBody,
            taskCard,
          ];
          return json(200, { messages: [taskCard] });
        }
        return undefined;
      },
    });
    await openChat();

    const card = await screen.findByRole('region', { name: '问题卡' });
    expect(within(card).getByText('先确认两件事。')).toBeTruthy();
    // 默认项已经选好，每题都有「你看着办」
    expect(within(card).getByRole('radio', { name: /游客/ })).toHaveProperty('checked', true);
    expect(within(card).getAllByRole('radio', { name: '你看着办' })).toHaveLength(2);
    fireEvent.click(within(card).getByRole('radio', { name: '合作方' }));
    fireEvent.click(within(card).getByRole('button', { name: '好了，继续' }));

    const sheetCard = await screen.findByRole('region', { name: '任务单' });
    expect(within(sheetCard).getByText('小木屋民宿官网首页')).toBeTruthy();
    expect(within(sheetCard).getByText('有标题、卖点和预订方式')).toBeTruthy();
    expect(api.bodies.find((b) => b.path.endsWith('/intake/answers'))?.body).toEqual({
      messageId: questions.id,
      answers: { q1: 'b', q2: 'a' },
      skip: false,
    });
    // 答过的问题卡只显示答案
    const answered = screen.getByRole('region', { name: '问题卡' });
    expect(within(answered).getByText('已回答')).toBeTruthy();
    expect(within(answered).queryByRole('radio')).toBeNull();

    fireEvent.click(within(sheetCard).getByRole('button', { name: '确认，开始做' }));
    const taskRegion = await screen.findByRole('region', { name: `任务：${SHEET.title}` });
    expect(await within(taskRegion).findAllByText('正在搭建工作流')).not.toHaveLength(0);
    expect(
      within(screen.getByRole('region', { name: '任务单' })).getByText('已交给 AI 团队'),
    ).toBeTruthy();
  });

  it('「要改一下」把焦点交给输入框并提示怎么说；「不是任务」退出', async () => {
    const sheet = message('sheet', {
      intakeId: INTAKE,
      sheet: SHEET,
      status: 'open',
      taskId: null,
    });
    const { chat, api } = fakeChat([message('text', {}, 'user', '写首页'), sheet], {
      extra: (method, path) => {
        if (method !== 'POST' || !path.endsWith('/intake/cancel')) return undefined;
        const reply = message('text', {}, 'assistant', '好的，先不做了。');
        chat.messages = [...chat.messages, reply];
        return json(200, { messages: [reply] });
      },
    });
    await openChat();
    const card = await screen.findByRole('region', { name: '任务单' });
    fireEvent.click(within(card).getByRole('button', { name: '要改一下' }));
    const input = screen.getByLabelText('消息');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('placeholder')).toMatch(/要改哪里/);

    fireEvent.click(within(card).getByRole('button', { name: '不做了' }));
    expect(await screen.findByText('好的，先不做了。')).toBeTruthy();
    expect(api.requests).toContain(`POST /conversation/v1/conversations/${CONV}/intake/cancel`);
  });
});

describe('任务卡', () => {
  it('显示完成几步、每步的状态和花费', async () => {
    fakeChat([message('task', { taskId: TASK })], { task: () => task() });
    await openChat();
    const card = await screen.findByRole('region', { name: `任务：${SHEET.title}` });
    expect(await within(card).findByText('2 个步骤，完成了 1 个')).toBeTruthy();
    const steps = within(card).getByRole('list', { name: '步骤' });
    expect(within(steps).getByText('：运行中')).toBeTruthy();
    expect(within(card).getByText('$0.0123')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '停止' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: '看工作流' }).getAttribute('href')).toBe(
      `/canvas/tasks/${TASK}`,
    );
  });

  it('需要处理仅保留简短状态和工作流入口，历史重复提醒不再刷屏', async () => {
    const details = '店内 13 类陈设的原始预览证据不足。';
    const { api } = fakeChat(
      [
        message('task', { taskId: TASK }),
        message('notice', { taskId: TASK, status: 'needs_attention', message: details }),
        message('notice', { taskId: TASK, status: 'needs_attention', message: details }),
      ],
      {
        task: () =>
          task({
            status: 'needs_attention',
            attention: { reason: 'checks_incomplete', nodeId: NODE_B, message: details },
          }),
      },
    );
    await openChat();
    const card = await screen.findByRole('region', { name: `任务：${SHEET.title}` });
    expect(await within(card).findByText('有待处理项，请到工作流查看对应节点。')).toBeTruthy();
    expect(within(card).getByRole('link', { name: '看工作流' }).getAttribute('href')).toBe(
      `/canvas/tasks/${TASK}`,
    );
    expect(screen.queryByText(details)).toBeNull();
    expect(screen.queryByRole('region', { name: '任务提醒' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(api.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('规划失败也可从原任务卡进入工作流处理', async () => {
    fakeChat([message('task', { taskId: TASK })], {
      task: () =>
        task({
          status: 'needs_attention',
          nodes: [],
          attention: { reason: 'plan_failed', nodeId: null, message: '工作流没排好' },
        }),
    });
    await openChat();
    const card = await screen.findByRole('region', { name: `任务：${SHEET.title}` });
    expect(await within(card).findByRole('link', { name: '看工作流' })).toBeTruthy();
    expect(screen.queryByText('工作流没排好')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新规划' })).toBeNull();
  });
});

describe('交付消息', () => {
  it('按交付物列出文件，可以预览和下载；没满足的地方写出来', async () => {
    fakeChat(
      [
        message('delivery', {
          taskId: TASK,
          title: SHEET.title,
          files: [{ deliverable: '首页文案', nodeId: NODE_A, path: '文案/首页.md', size: 2048 }],
          unmet: ['没写预订电话'],
          warnings: [],
        }),
      ],
      { task: () => task({ status: 'succeeded', spentMicro: 18_700 }) },
    );
    await openChat();
    const card = await screen.findByRole('region', { name: `交付：${SHEET.title}` });
    expect(within(card).getByText('没写预订电话')).toBeTruthy();
    expect(within(card).getByText('2.0 KB')).toBeTruthy();
    const download = within(card).getByRole('link', { name: '下载 首页.md' });
    expect(download.getAttribute('href')).toBe(
      `/api/task/v1/tasks/${TASK}/files/${NODE_A}/${encodeURIComponent('文案')}/${encodeURIComponent('首页.md')}?download=1`,
    );
    fireEvent.click(within(card).getByRole('button', { name: '预览 首页.md' }));
    expect(screen.getByRole('heading', { name: '首页.md', hidden: true })).toBeTruthy();
  });
});

describe('私聊文字操作', () => {
  it('长文保持短预览，全文放弹窗；任务消息带标记且没有修改入口', async () => {
    const text = '很长的任务内容。'.repeat(100) + '正文末尾';
    fakeChat([message('text', { intent: 'task' }, 'user', text)]);
    await openChat();
    expect(await screen.findByText('任务 · 已锁定')).toBeTruthy();
    expect(screen.queryByText(/正文末尾/)).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑消息' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除消息' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /查看全文/ }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText(text)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭', hidden: true }));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(screen.queryByText(/正文末尾/)).toBeNull();
  });

  it('普通聊天可以编辑、重新生成、删除；前端替换缓存中的旧回复', async () => {
    const user = message('text', { intent: 'chat' }, 'user', '旧问题');
    const reply = message('text', { replyTo: user.id }, 'assistant', '旧回复');
    const { chat, api } = fakeChat([user, reply], {
      extra: (method, path, body) => {
        if (method === 'POST' && path.endsWith(`/${user.id}/reply`)) {
          const content = (body as { content?: string }).content;
          const updated = { ...user, content: content ?? chat.messages[0]!.content };
          const answered = { ...reply, content: content ? '编辑后的回复' : '重生成的回复' };
          chat.messages = [updated, answered];
          return new Response(
            [
              { type: 'accepted', userMessage: updated },
              { type: 'done', message: answered },
            ]
              .map((e) => `data: ${JSON.stringify(e)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        if (method === 'DELETE' && path.endsWith(`/${user.id}`)) {
          chat.messages = [];
          return new Response(null, { status: 204 });
        }
      },
    });
    await openChat();
    fireEvent.click(await screen.findByRole('button', { name: '编辑消息' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.change(within(dialog).getByLabelText('修改消息内容'), {
      target: { value: '新问题' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并重新生成', hidden: true }));
    expect(await screen.findByText('编辑后的回复')).toBeTruthy();
    expect(screen.queryByText('旧问题')).toBeNull();
    expect(screen.queryByText('旧回复')).toBeNull();
    // 重新生成和删除先问一句：取消不执行，确认才执行
    fireEvent.click(await screen.findByRole('button', { name: '重新生成回复' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: '重新生成回复？' })).getByRole('button', {
        name: '取消',
      }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.bodies.filter((b) => b.path.endsWith('/reply'))).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '重新生成回复' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: '重新生成' }),
    );
    expect(await screen.findByText('重生成的回复')).toBeTruthy();
    expect(api.bodies.filter((b) => b.path.endsWith('/reply')).map((b) => b.body)).toEqual([
      { content: '新问题' },
      {},
    ]);
    fireEvent.click(screen.getByRole('button', { name: '删除消息' }));
    // 点外面收起，不删
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('新问题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除消息' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', { name: '删除这条消息？' })).getByRole('button', {
        name: '删除',
      }),
    );
    await screen.findByText(/打个招呼/);
    expect(screen.queryByText('新问题')).toBeNull();
    expect(screen.queryByText('重生成的回复')).toBeNull();
  });

  it('回复期间按钮变为停止，只调用私聊 stop，不调用任务控制', async () => {
    const user = message('text', { intent: 'chat' }, 'user', '聊天');
    const stopped = message('text', { replyTo: user.id, stopped: true }, 'assistant', '保留的部分');
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const push = (event: object) =>
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const { chat, api } = fakeChat([], {
      extra: (method, path) => {
        if (method === 'POST' && path.endsWith('/messages')) {
          chat.messages = [user];
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                push({ type: 'accepted', userMessage: user });
                push({ type: 'delta', text: '保留的部分' });
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        if (method === 'POST' && path.endsWith(`/${user.id}/stop`)) {
          chat.messages = [user, stopped];
          push({ type: 'done', message: stopped });
          stream.close();
          return new Response(null, { status: 204 });
        }
      },
    });
    await openChat();
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '聊天' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止回复' }));
    expect(await screen.findByText('已停止')).toBeTruthy();
    expect(api.requests.some((r) => r.includes('/task/') || r.includes('/harness/'))).toBe(false);
  });
});

describe('发任务', () => {
  it('「＋」里选「作为任务发布」，发消息时带上 asTask', async () => {
    const { chat, api } = fakeChat([], {
      extra: (method, path) => {
        if (method !== 'POST' || path !== `/conversation/v1/conversations/${CONV}/messages`)
          return undefined;
        const userMessage = message('text', {}, 'user', '做个海报');
        const card = message('questions', QUESTIONS);
        chat.messages = [userMessage, card];
        const events = [
          { type: 'accepted', userMessage },
          { type: 'done', message: card },
        ];
        return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    await openChat();
    fireEvent.click(await screen.findByRole('button', { name: '更多发送方式' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /作为任务发布/ }));
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '做个海报' } });
    fireEvent.click(screen.getByRole('button', { name: '发布任务' }));
    expect(await screen.findByRole('region', { name: '问题卡' })).toBeTruthy();
    expect(api.bodies.find((b) => b.path.endsWith('/messages'))?.body).toEqual({
      content: '做个海报',
      asTask: true,
      attachments: [],
    });
    // 发出去后回到普通发送
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
  });
});

describe('修改成果（ADR 0012）', () => {
  const delivery = (extra: object = {}) =>
    message('delivery', {
      taskId: TASK,
      title: SHEET.title,
      files: [{ deliverable: '首页文案', nodeId: NODE_A, path: '首页.md', size: 120 }],
      unmet: [],
      warnings: [],
      ...extra,
    });

  it('交付消息上「改一版」：写修改意见发给做出这一版的 AI，私聊里出现修改的任务卡', async () => {
    const REVISION = '00000000-0000-4000-8000-0000000000f2';
    const card = delivery();
    const { chat, api } = fakeChat([card], {
      task: () => task({ status: 'succeeded', finishedAt: NOW }),
      extra: (method, path) => {
        if (method === 'POST' && path === `/conversation/v1/conversations/${CONV}/revisions`) {
          const revised = message('task', { taskId: REVISION, revisionOf: TASK });
          chat.messages = [card, message('text', {}, 'user', '修改：标题改成山居'), revised];
          return json(200, { messages: chat.messages.slice(1) });
        }
        if (method === 'GET' && path === `/task/v1/tasks/${REVISION}`)
          return json(200, task({ id: REVISION, status: 'planning', nodes: [] }));
        if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
        return undefined;
      },
    });
    await openChat();
    const region = await screen.findByRole('region', { name: `交付：${SHEET.title}` });
    fireEvent.click(await within(region).findByRole('button', { name: /改一版/ }));
    // jsdom 里 <dialog> 没有 showModal，里面的元素按 aria-label、hidden 查
    const dialog = await screen.findByLabelText(`修改「${SHEET.title}」`);
    expect(
      await within(dialog).findByRole('option', { name: 'Claude（做出这一版的）', hidden: true }),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('要怎么改'), {
      target: { value: '标题改成山居' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '发给 AI 修改', hidden: true }));
    expect(await screen.findByRole('region', { name: `修改：${SHEET.title}` })).toBeTruthy();
    expect(
      api.bodies.find((b) => b.path.endsWith(`/conversations/${CONV}/revisions`))?.body,
    ).toEqual({
      taskId: TASK,
      request: '标题改成山居',
      annotations: [],
      parameters: [],
      attachments: [],
    });
  });

  it('被替换、被删除的任务：卡片只留一句话，不再查任务、不给下载', async () => {
    const { api } = fakeChat([
      message('task', { taskId: TASK, removed: { replacedBy: NODE_B } }),
      delivery({ removed: { replacedBy: null } }),
    ]);
    await openChat();
    expect(await screen.findByText('这一版已被修改后的新版替换，旧版本不保留。')).toBeTruthy();
    expect(screen.getByText('这个任务和它的成果已删除。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /首页\.md/ })).toBeNull();
    expect(api.requests.some((r) => r.includes(`/task/v1/tasks/${TASK}`))).toBe(false);
  });
});
