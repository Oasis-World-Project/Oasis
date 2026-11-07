// 工作流视图（5.5b）：节点和状态、节点详情、整体运行、加节点并接线、删连线、追问。
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
    estimateMicro: 30_000,
    spentMicro: 4_200,
    budgetLimitMicro: 90_000,
    sheet: null,
    materials: [],
    revisionOf: null,
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
      }),
      node(B, 'copy', '写首页文案', 'stopped', { warning: '卖点只写了两条' }),
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
    extra: (method, path, body) => {
      const base = `/task/v1/tasks/${TASK}`;
      if (method === 'GET' && path === base) return json(200, task);
      if (method === 'GET' && path === '/task/v1/workflow/options')
        return json(200, {
          models: [
            { key: 'deepseek', name: 'DeepSeek', vendor: '深度求索', providerModel: 'deepseek/x' },
          ],
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
            ? [{ seq: 0, kind: 'assistant_text', data: { text: '先写标题' }, createdAt: NOW }]
            : [],
        });
      if (method === 'POST' && path === `${base}/run`) {
        task = { ...task, status: 'running' };
        return json(200, task);
      }
      if (method === 'POST' && path === `${base}/nodes`) {
        const added = body as { key: string; title: string };
        task = {
          ...task,
          nodes: [
            ...task.nodes,
            node('00000000-0000-4000-8000-0000000000a4', added.key, added.title, 'draft'),
          ],
        } as TaskBody;
        return json(201, task);
      }
      if (method === 'POST' && path === `${base}/edges`) {
        const { from, to } = body as { from: string; to: string };
        task = {
          ...task,
          edges: [...task.edges, { id: 'e0000000-0000-4000-8000-000000000009', from, to }],
        };
        return json(201, task);
      }
      if (method === 'DELETE' && path.startsWith(`${base}/edges/`)) {
        task = { ...task, edges: task.edges.filter((e) => !path.endsWith(e.id)) };
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
  it('节点逐项展示通过/未通过/未检查、原因和证据；需要处理时不假装仍在检查', async () => {
    task = {
      ...task,
      status: 'needs_attention',
      attention: { reason: 'checks_incomplete', nodeId: B, message: '检查尚未完成' },
    };
    task.nodes[1] = {
      ...task.nodes[1]!,
      status: 'checking',
      gateChecks: [
        {
          id: 'c1',
          text: '13 类陈设清晰可辨',
          status: 'unchecked',
          reason: '现有图片无法辨认咖啡机，需要补齐原始预览证据。',
          evidence: ['preview/hero.png'],
        },
        {
          id: 'c2',
          text: '所有声明文件已交付',
          status: 'unmet',
          reason: '明确缺少已声明的 tools/build.py。',
          evidence: ['report.md'],
        },
        {
          id: 'c3',
          text: '几何资源有效',
          status: 'passed',
          reason: '几何检查完成。',
          evidence: ['scene.glb'],
        },
      ],
    };
    const api = fakeWorkflow();
    await openWorkflow();
    expect(await nodeButton(/^写首页文案，检查停下了$/)).toBeTruthy();
    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    const checks = within(panel).getByRole('list', { name: '逐项检查结果' });
    expect(within(checks).getByText('未检查')).toBeTruthy();
    expect(within(checks).getByText('未通过')).toBeTruthy();
    expect(within(checks).getByText('通过')).toBeTruthy();
    expect(within(checks).getByText('现有图片无法辨认咖啡机，需要补齐原始预览证据。')).toBeTruthy();
    expect(within(checks).getByText('证据：preview/hero.png')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '继续' })).toBeTruthy();
    // 检查停下时也可以跳过检查，不会卡死
    expect(within(panel).getByRole('button', { name: '跳过检查' })).toBeTruthy();
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

  it('取消后仍能从问题入口查看最后的检查依据，但不能运行或重查', async () => {
    task = { ...task, status: 'cancelled', attention: null };
    task.nodes[0] = {
      ...task.nodes[0]!,
      gateChecks: [
        {
          id: 'final',
          text: '最终整体观感',
          status: 'unchecked',
          reason: '本阶段只制定契约，留待成品核验。',
          evidence: [],
        },
      ],
    };
    task.nodes[1] = {
      ...task.nodes[1]!,
      status: 'cancelled',
      gateChecks: [
        {
          id: 'c1',
          text: '室内陈设',
          status: 'unchecked',
          reason: '缺少原始预览图。',
          evidence: ['preview/hero.png'],
        },
      ],
    };
    const api = fakeWorkflow();
    await openWorkflow();
    const overview = screen.getByRole('region', { name: '待查看的节点' });
    expect(within(overview).queryByRole('button', { name: '查看节点记录：理清卖点' })).toBeNull();
    fireEvent.click(within(overview).getByRole('button', { name: /写首页文案/ }));
    const panel = await screen.findByRole('complementary', { name: '节点：写首页文案' });
    expect(within(panel).getByText('缺少原始预览图。')).toBeTruthy();
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

  it('很长的检查原因默认折叠，展开后仍可阅读完整原因并继续', async () => {
    const message = '正文截断；vendor/three.module.js；'.repeat(100);
    task = {
      ...task,
      status: 'needs_attention',
      attention: { reason: 'checks_incomplete', nodeId: B, message },
    };
    const api = fakeWorkflow();
    await openWorkflow();
    expect(screen.getByRole('status').textContent).toBe('检查停下了');
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
    // 停止的节点可以继续，开始过的不能编辑和删除
    expect(within(panel).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: '编辑' })).toBeNull();
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

  it('加一个节点并接在别的节点后面；在详情里删掉一条连线', async () => {
    const api = fakeWorkflow();
    await openWorkflow();
    fireEvent.click(await screen.findByRole('button', { name: '加节点' }));
    const dialog = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('dialog[aria-label="加一个节点"]');
      if (!found) throw new Error('还没打开加节点的窗口');
      return found;
    });
    fireEvent.change(within(dialog).getByLabelText('名字'), { target: { value: '英文版' } });
    fireEvent.change(within(dialog).getByLabelText('要做的事'), {
      target: { value: '把文案翻成英文' },
    });
    fireEvent.change(within(dialog).getByLabelText(/接在哪个节点后面/), { target: { value: B } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加上', hidden: true }));

    await waitFor(() =>
      expect(api.bodies.find((b) => b.path.endsWith('/edges'))?.body).toEqual({
        from: B,
        to: '00000000-0000-4000-8000-0000000000a4',
      }),
    );
    expect(api.bodies.find((b) => b.path.endsWith('/nodes'))?.body).toMatchObject({
      key: '英文版',
      kind: 'work',
      title: '英文版',
      goal: '把文案翻成英文',
      model: 'deepseek/x',
    });
    // 新节点加好后自动选中，详情里能看到上游，可以删掉这条线
    const panel = await screen.findByRole('complementary', { name: '节点：英文版' });
    fireEvent.click(within(panel).getByRole('button', { name: '删掉来自写首页文案的连线' }));
    await waitFor(() =>
      expect(within(panel).getByText('没有上游，直接从任务开始做。')).toBeTruthy(),
    );
  });

  it('修改方案待确认：显示规划员的说明、每个步骤怎么处理和预计花费，确认后才开跑（ADR 0022）', async () => {
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
        estimateMicro: 30_000,
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
    expect(screen.getByText(/预计约 \$0\.03/)).toBeTruthy();
    // 方案按现在的节点排：等确认时不能改工作流
    expect(screen.queryByRole('button', { name: '加节点' })).toBeNull();
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
        estimateMicro: null,
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
