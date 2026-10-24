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
});
