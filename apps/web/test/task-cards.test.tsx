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

  it('节点失败时可以再试、跳过继续或取消；取消要再确认一次', async () => {
    let current = task({
      status: 'needs_attention',
      attention: { reason: 'node_failed', nodeId: NODE_B, message: '「出效果图」没能完成' },
    });
    const { api } = fakeChat([message('task', { taskId: TASK })], {
      task: () => current,
      extra: (method, path) => {
        if (method === 'POST' && path === `/task/v1/tasks/${TASK}/decision`) {
          current = task({ status: 'running' });
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    });
    await openChat();
    const card = await screen.findByRole('region', { name: `任务：${SHEET.title}` });
    expect(await within(card).findByText('「出效果图」没能完成')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '跳过它继续' })).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: '取消任务' }));
    expect(within(card).getByRole('group', { name: '取消后不能恢复，确定吗？' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '算了' }));

    fireEvent.click(within(card).getByRole('button', { name: '再试一次' }));
    expect(await within(card).findByText('进行中')).toBeTruthy();
    expect(api.bodies.find((b) => b.path.endsWith('/decision'))?.body).toEqual({ choice: 'retry' });
  });

  it('规划失败只能重新规划或取消', async () => {
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
    expect(await within(card).findByRole('button', { name: '重新规划' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: '跳过它继续' })).toBeNull();
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
