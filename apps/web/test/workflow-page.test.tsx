// 工作流视图：每样成果一个框（AI 自己列的任务清单、生产线）、状态、详情、整体运行、追问。节点和连线不能改。
import type { TaskBody } from '@oasis/contracts/task';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';

const NOW = '2026-10-24T08:00:00.000Z';
const TASK = '00000000-0000-4000-8000-0000000000f1';
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000a2';
const C = '00000000-0000-4000-8000-0000000000a3';
const RUN = '00000000-0000-4000-8000-0000000000b1';

function node(id: string, key: string, title: string, status: string, extra: object = {}) {
  return {
    id,
    key,
    title,
    kind: 'work',
    role: '',
    goal: `${title}的说明`,
    model: 'deepseek/x',
    expects: [],
    line: null,
    adjust: null,
    discussion: null,
    steps: null,
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
    ...extra,
  };
}

function baseTask(): TaskBody {
  return {
    id: TASK,
    title: '民宿首页',
    brief: '',
    status: 'stopped',
    attention: null,
    spentMicro: 4_200,
    sheet: null,
    materials: [],
    version: 1,
    versions: [],
    revision: null,
    revising: false,
    acceptance: null,
    deliverables: [],
    nodes: [
      node(A, 'research', '理清卖点', 'succeeded', {
        outputs: [{ path: '卖点.md', size: 820 }],
        spentMicro: 4_200,
        startedAt: NOW,
      }),
      node(B, 'copy', '写首页文案', 'stopped', { warning: '卖点只写了两条', startedAt: NOW }),
      node(C, 'image', '出效果图', 'waiting'),
    ],
    edges: [
      { id: 'e0000000-0000-4000-8000-000000000001', from: A, to: B },
      { id: 'e0000000-0000-4000-8000-000000000002', from: A, to: C },
    ],
    createdAt: NOW,
    finishedAt: null,
  } as TaskBody;
}

let task: TaskBody;

function fakeWorkflow() {
  return installFakeApi({
    signedIn: true,
    extra: (method, path) => {
      const base = `/task/v1/tasks/${TASK}`;
      if (method === 'GET' && path === base) return json(200, task);
      if (method === 'GET' && path === '/task/v1/workflow/names')
        return json(200, {
          models: [{ key: 'deepseek', name: 'DeepSeek', providerModel: 'deepseek/x' }],
          tools: [],
        });
      if (method === 'GET' && path.endsWith('/runs'))
        return json(200, {
          runs: path.includes(B)
            ? [
                {
                  id: RUN,
                  purpose: 'work',
                  status: 'stopped',
                  attempt: 1,
                  round: null,
                  participant: null,
                  continued: false,
                  summary: null,
                  error: null,
                  createdAt: NOW,
                  finishedAt: NOW,
                },
              ]
            : [],
        });
      if (method === 'GET' && path.includes('/events'))
        return json(200, {
          events: path.includes('after=-1')
            ? [
                { seq: 0, kind: 'assistant_text', data: { text: '先写标题' }, createdAt: NOW },
                {
                  seq: 1,
                  kind: 'tool_call',
                  data: {
                    callId: 'c1',
                    name: 'todo_write',
                    arguments: JSON.stringify({
                      todos: [
                        { content: '写标题', status: 'completed' },
                        { content: '写卖点', status: 'in_progress' },
                      ],
                    }),
                  },
                  createdAt: NOW,
                },
              ]
            : [],
        });
      if (method === 'POST' && path === `${base}/run`) {
        task = { ...task, status: 'running' };
        return json(200, task);
      }
      if (method === 'POST' && path.endsWith('/messages')) return json(202, { result: 'noted' });
      if (method === 'DELETE' && path === base) return new Response(null, { status: 204 });
      // 冻结的第 1 版（ADR 0022）：只有 A、B 两个节点
      if (method === 'GET' && path === `${base}/versions/1`)
        return json(200, {
          version: 1,
          request: null,
          createdAt: NOW,
          frozenAt: NOW,
          nodes: [task.nodes[0], { ...task.nodes[1], status: 'succeeded' }],
          edges: [task.edges[0]],
          spentMicro: 1_000,
        });
      if (method === 'POST' && path === `${base}/decision`) {
        task = { ...task, status: 'running', attention: null, revision: null, version: 2 };
        return json(200, task);
      }
      if (method === 'POST' && path === `${base}/cancel`) {
        task = { ...task, status: 'succeeded', revision: null, revising: false };
        return json(200, task);
      }
      if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
      if (method === 'GET' && path === '/canvas/v1/artifacts') return json(200, { artifacts: [] });
      return undefined;
    },
  });
}

async function openWorkflow() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/canvas/tasks/${TASK}`] }),
  });
  await act(() => router.load());
  render(<App />);
  await screen.findByRole('heading', { name: '民宿首页 的工作流' });
}

beforeEach(() => {
  task = baseTask();
  // React Flow 要量尺寸；jsdom 里没有
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const nodeButton = (name: RegExp) => screen.findByRole('button', { name, hidden: true });

describe('工作流视图', () => {
  it('节点详情说清检查到哪了：检查中、通过、有提醒（关卡只查文件齐不齐、能不能打开）', async () => {
    task.nodes[0] = { ...task.nodes[0]!, warning: '没检查到：浏览器检查超时' };
    task.nodes[1] = { ...task.nodes[1]!, status: 'checking' };
    task.nodes[2] = { ...task.nodes[2]!, status: 'succeeded' };
    const api = fakeWorkflow();
    await openWorkflow();
    fireEvent.click(await nodeButton(/^写首页文案，检查中$/));
    let panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    expect(within(panel).getByText('检查进行中，尚未生成结果。')).toBeTruthy();
    fireEvent.click(await nodeButton(/^理清卖点，完成$/));
    panel = await screen.findByRole('complementary', { name: '节点：理清卖点' });
    expect(within(panel).getByText('检查过了，有提醒（见下方）。')).toBeTruthy();
    expect(within(panel).getByText(/浏览器检查超时/)).toBeTruthy();
    fireEvent.click(await nodeButton(/^出效果图，完成$/));
    panel = await screen.findByRole('complementary', { name: '节点：出效果图' });
    expect(within(panel).getByText('检查通过：交付的文件齐全，能打开。')).toBeTruthy();
    expect(api.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('等待节点能定位未完成的上游，不把它说成自身检查失败', async () => {
    task.edges = [{ id: 'e0000000-0000-4000-8000-000000000001', from: B, to: C }];
    fakeWorkflow();
    await openWorkflow();
    fireEvent.click(await nodeButton(/^出效果图，等上游$/));
    const panel = await screen.findByRole('complementary', { name: '节点：出效果图' });
    expect(within(panel).getByText(/不代表本节点检查失败/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '写首页文案 · 查看原因' }));
    expect(await screen.findByRole('complementary', { name: '节点：写首页文案' })).toBeTruthy();
  });

  it('取消后仍能从问题入口查看节点留下的提醒，但不能运行或重查', async () => {
    task = { ...task, status: 'cancelled', attention: null };
    // 已完成节点的提醒不算「需要查看」
    task.nodes[0] = { ...task.nodes[0]!, warning: '没检查到：浏览器检查超时' };
    task.nodes[1] = {
      ...task.nodes[1]!,
      status: 'cancelled',
      warning: '原定的模型 openai/blocked 在当前网络用不了，改用 deepseek/x',
    };
    const api = fakeWorkflow();
    await openWorkflow();
    const overview = screen.getByRole('region', { name: '待查看的节点' });
    expect(within(overview).queryByRole('button', { name: '查看节点记录：理清卖点' })).toBeNull();
    fireEvent.click(within(overview).getByRole('button', { name: /写首页文案/ }));
    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    expect(within(panel).getByText(/改用 deepseek\/x/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: '运行' })).toBeNull();
    expect(api.requests.some((r) => r.startsWith('POST'))).toBe(false);
  });

  it('删除任务：确认后先停下再删，回到画布，不再拉这个任务', async () => {
    const api = fakeWorkflow();
    await openWorkflow();
    fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
    const ask = screen.getByRole('group', { name: '会先停下，再连同工作流删掉，不能恢复？' });
    fireEvent.click(within(ask).getByRole('button', { name: '删除' }));
    expect(await screen.findByRole('heading', { name: '画布' })).toBeTruthy();
    expect(api.requests).toContain(`DELETE /task/v1/tasks/${TASK}`);
    const fetchedAfter = api.requests.slice(
      api.requests.indexOf(`DELETE /task/v1/tasks/${TASK}`) + 1,
    );
    expect(fetchedAfter).not.toContain(`GET /task/v1/tasks/${TASK}`);
  });

  it('停在某个节点时，「继续」只在这个节点的详情里；关掉详情后外面没有按钮', async () => {
    task = {
      ...task,
      nodes: task.nodes.map((n) => (n.id === B ? { ...n, status: 'failed' as const } : n)),
      status: 'needs_attention',
      attention: {
        reason: 'node_failed',
        nodeId: B,
        message: '「写首页文案」连不上模型服务商（网络中断或超时）',
      },
    };
    fakeWorkflow();
    await openWorkflow();
    // 自动打开停下的节点，里面有原因和「继续」
    expect(screen.getByRole('button', { name: '继续' })).toBeTruthy();
    expect(screen.getByText('「写首页文案」连不上模型服务商（网络中断或超时）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭节点详情' }));
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
  });

  it('很长的原因默认折叠，展开后仍可阅读完整原因并继续', async () => {
    const message = '「写首页文案」连不上模型服务商；vendor/three.module.js；'.repeat(100);
    task = {
      ...task,
      nodes: task.nodes.map((n) => (n.id === B ? { ...n, status: 'failed' as const } : n)),
      status: 'needs_attention',
      attention: { reason: 'node_failed', nodeId: B, message },
    };
    const api = fakeWorkflow();
    await openWorkflow();
    expect(screen.getByRole('status').textContent).toBe('任务需要处理');
    const summary = screen.getByText('查看详细原因');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText(message)).toBeTruthy();
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(within(details.parentElement!).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(api.requests.some((request) => request.endsWith('/decide'))).toBe(false);
  });

  it('画出每个节点和状态；点节点看详情：关卡提醒、上游、运行过程', async () => {
    fakeWorkflow();
    await openWorkflow();
    expect(await nodeButton(/^理清卖点，完成$/)).toBeTruthy();
    expect(await nodeButton(/^出效果图，等上游$/)).toBeTruthy();
    fireEvent.click(await nodeButton(/^写首页文案，已停止$/));

    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    expect(within(panel).getByText('关卡提醒：卖点只写了两条')).toBeTruthy();
    expect(within(panel).getByText(/理清卖点/)).toBeTruthy();
    // 停止的可以继续；节点和连线不能改
    expect(within(panel).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /编辑|删除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '加节点' })).toBeNull();
    // 最近一次运行默认展开
    expect(await within(panel).findByText('先写标题')).toBeTruthy();
  });

  it('全部运行；给已停止的节点补要求会记下来', async () => {
    const api = fakeWorkflow();
    await openWorkflow();
    fireEvent.click(await screen.findByRole('button', { name: '全部运行' }));
    expect(await screen.findByRole('button', { name: '全部停止' })).toBeTruthy();
    expect(api.requests).toContain(`POST /task/v1/tasks/${TASK}/run`);

    fireEvent.click(await nodeButton(/^写首页文案/));
    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    fireEvent.change(within(panel).getByLabelText('给这个节点补要求'), {
      target: { value: '标题短一点' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '发送' }));
    expect(await within(panel).findByText('记下了，开跑或继续时会带上。')).toBeTruthy();
  });

  it('一个 AI 做的成果：框里是它自己列的任务清单，详情里看得到整份', async () => {
    fakeWorkflow();
    await openWorkflow();
    const list = await screen.findByRole('list', { name: '任务清单', hidden: true });
    expect(
      within(list)
        .getAllByRole('listitem', { hidden: true })
        .map((li) => li.textContent),
    ).toEqual(['写标题', '写卖点']);
    // 还没开始的成果没有清单：框里是要做的事
    expect(within(await nodeButton(/^出效果图，等上游$/)).getByText('出效果图的说明')).toBeTruthy();
    fireEvent.click(await nodeButton(/^写首页文案，已停止$/));
    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    expect(within(panel).getByText('它自己列的任务清单')).toBeTruthy();
    expect(within(panel).getByText('写卖点')).toBeTruthy();
  });

  it('中途调整：提出调整的框写着「正在调整」，被调整的写着改了什么', async () => {
    task.nodes[1] = { ...task.nodes[1]!, adjust: { asking: true, note: '加一份常见问题' } };
    task.nodes[2] = { ...task.nodes[2]!, adjust: { asking: false, note: '说明改了：别写价格' } };
    fakeWorkflow();
    await openWorkflow();
    const asking = await nodeButton(/^写首页文案，已停止$/);
    expect(within(asking).getByText('正在调整：加一份常见问题')).toBeTruthy();
    const changed = await nodeButton(/^出效果图，等上游$/);
    expect(within(changed).getByText('调整：说明改了：别写价格')).toBeTruthy();
    fireEvent.click(changed);
    const panel = await screen.findByRole('complementary', { name: '节点：出效果图' });
    expect(within(panel).getByText('中途调整')).toBeTruthy();
  });

  it('生产线：它的节点框在一起，框上写着做完了几个', async () => {
    const line = { key: 'film', title: '成片' };
    const tool = { kind: 'tool' as const, model: '', steps: [], warning: null, line };
    task.nodes[1] = { ...task.nodes[1]!, ...tool, status: 'succeeded' };
    task.nodes[2] = { ...task.nodes[2]!, ...tool };
    fakeWorkflow();
    await openWorkflow();
    const frame = await screen.findByRole('group', { name: '生产线：成片', hidden: true });
    expect(within(frame).getByText('生产线 · 1 / 2 完成')).toBeTruthy();
    expect(await nodeButton(/^写首页文案，完成$/)).toBeTruthy();
    expect(await nodeButton(/^出效果图，等上游$/)).toBeTruthy();
  });

  it('修改方案待确认：显示规划员的说明、每个步骤怎么处理，确认后才开跑（ADR 0022）', async () => {
    task = {
      ...task,
      status: 'needs_attention',
      revising: true,
      attention: { reason: 'revision_plan', nodeId: null, message: '只改网页灯光' },
      revision: {
        version: 2,
        stage: 'confirm',
        request: '加点光',
        summary: '只改网页灯光，模型沿用。',
        changes: [
          { key: 'research', title: '理清卖点', change: 'reuse' },
          { key: 'copy', title: '写首页文案', change: 'continue' },
          { key: 'image', title: '出效果图', change: 'remove' },
        ],
      },
    };
    const api = fakeWorkflow();
    await openWorkflow();
    expect(screen.getByText('修改中')).toBeTruthy();
    expect(screen.getByText('修改方案待确认')).toBeTruthy();
    expect(await screen.findByText('只改网页灯光，模型沿用。')).toBeTruthy();
    const list = screen.getByRole('list', { name: '每个步骤怎么处理' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['沿用理清卖点', '接着改写首页文案', '删除出效果图']);
    // 方案按现在的节点排：等确认时不能运行、停止
    expect(screen.queryByRole('button', { name: '全部运行' })).toBeNull();
    expect(screen.getByRole('button', { name: '不改了' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认修改' }));
    await waitFor(() =>
      expect(api.bodies.find((b) => b.path.endsWith('/decision'))?.body).toEqual({
        choice: 'continue',
      }),
    );
  });

  it('规划修改时工作流照旧显示，可以不改了；改过的任务能切到旧版只读查看', async () => {
    task = {
      ...task,
      status: 'planning',
      revising: true,
      version: 2,
      versions: [{ version: 1, request: null, createdAt: NOW, frozenAt: NOW }],
      revision: {
        version: 3,
        stage: 'planning',
        request: '再亮一点',
        summary: null,
        changes: [],
      },
    };
    const api = fakeWorkflow();
    await openWorkflow();
    expect(screen.getByText('正在规划修改')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('AI 团队在看上一版');
    expect(await nodeButton(/出效果图/)).toBeTruthy();

    const tabs = screen.getByRole('tablist', { name: '工作流版本' });
    fireEvent.click(within(tabs).getByRole('tab', { name: '第 1 版' }));
    expect(await screen.findByText('第 1 版 · 只读')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /出效果图/, hidden: true })).toBeNull(),
    );
    expect(screen.getByText('2 / 2')).toBeTruthy();
    fireEvent.click(within(tabs).getByRole('tab', { name: '第 2 版（当前）' }));
    expect(await nodeButton(/出效果图/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '不改了' }));
    await waitFor(() => expect(api.bodies.some((b) => b.path.endsWith('/cancel'))).toBe(true));
  });
});
