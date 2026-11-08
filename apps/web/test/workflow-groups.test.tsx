// 工作流视图里的展开节点和做几版的节点（ADR 0026）：图上只有父节点的一叠卡片，详情里列出每一条、各版，
// 可以改用另一版。
import type { TaskBody } from '@oasis/contracts/task';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';

const NOW = '2026-11-08T08:00:00.000Z';
const TASK = '00000000-0000-4000-8000-0000000000f2';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIST = id(1);
const SHOTS = id(2);
const S1 = id(3);
const S2 = id(4);
const ART = id(5);
const V1 = id(6);
const V2 = id(7);

function node(nodeId: string, key: string, title: string, extra: object = {}) {
  return {
    id: nodeId,
    key,
    title,
    kind: 'tool',
    role: '',
    goal: `${title}的说明`,
    model: '',
    checks: [],
    expects: [],
    tools: [],
    discussion: null,
    steps: [],
    status: 'succeeded',
    attempts: 1,
    userNotes: [],
    reworks: 0,
    warning: null,
    summary: null,
    outputs: [],
    spentMicro: 0,
    startedAt: NOW,
    finishedAt: NOW,
    parentId: null,
    slot: null,
    foreach: null,
    variants: null,
    ...extra,
  };
}

let task: TaskBody;
let picked: unknown;

function baseTask(): TaskBody {
  const variants = { n: 2, pick: '构图贴近描述', chosen: 2, reason: '第 2 版人物在画面中央' };
  return {
    id: TASK,
    title: '分镜视频',
    brief: '',
    status: 'succeeded',
    attention: null,
    estimateMicro: 30_000,
    spentMicro: 9_000,
    budgetLimitMicro: null,
    sheet: null,
    materials: [],
    version: 1,
    versions: [],
    revision: null,
    revising: false,
    acceptance: null,
    deliverables: [],
    nodes: [
      node(LIST, 'list', '写分镜', { kind: 'work', model: 'deepseek/x', steps: null }),
      node(SHOTS, 'shots', '镜头', {
        kind: 'foreach',
        steps: null,
        foreach: {
          over: 'in/list/shots.json',
          count: 3,
          items: 2,
          each: { kind: 'tool', title: '镜头 {{index}}' },
        },
        outputs: [{ path: '01/frame.png', size: 5 }],
      }),
      node(S1, 'shots-01', '镜头 01', { parentId: SHOTS, slot: 1 }),
      node(S2, 'shots-02', '镜头 02', { parentId: SHOTS, slot: 2, status: 'running' }),
      node(ART, 'art', '海报', { variants, outputs: [{ path: 'a.png', size: 5 }] }),
      node(V1, 'art-v1', '海报（第 1 版）', {
        parentId: ART,
        slot: 1,
        outputs: [{ path: 'a.png', size: 5 }],
      }),
      node(V2, 'art-v2', '海报（第 2 版）', {
        parentId: ART,
        slot: 2,
        outputs: [{ path: 'a.png', size: 5 }],
      }),
    ],
    edges: [{ id: 'e0000000-0000-4000-8000-000000000001', from: LIST, to: SHOTS }],
    createdAt: NOW,
    finishedAt: NOW,
  } as TaskBody;
}

function fakeWorkflow() {
  return installFakeApi({
    signedIn: true,
    extra: (method, path, body) => {
      const base = `/task/v1/tasks/${TASK}`;
      if (method === 'GET' && path === base) return json(200, task);
      if (method === 'GET' && path === '/task/v1/workflow/options')
        return json(200, { models: [], tools: [] });
      if (method === 'GET' && path.endsWith('/runs')) return json(200, { runs: [] });
      if (method === 'GET' && path.includes('/events')) return json(200, { events: [] });
      if (method === 'POST' && path === `${base}/nodes/${ART}/pick`) {
        picked = body;
        task = {
          ...task,
          status: 'needs_attention',
          attention: { reason: 'revision_plan', nodeId: ART, message: '改用「海报」的第 1 版' },
          revision: {
            version: 2,
            stage: 'confirm',
            request: '改用「海报」的第 1 版',
            summary: '改用「海报」的第 1 版，受影响的 0 个下游节点重新做，预计最多 $0.00',
            estimateMicro: 0,
            changes: [],
          },
          revising: true,
        };
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
  await screen.findByRole('heading', { name: '分镜视频 的工作流' });
}

beforeEach(() => {
  task = baseTask();
  picked = undefined;
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

const card = (name: RegExp) => screen.findByRole('button', { name, hidden: true });

describe('展开节点和做几版的节点', () => {
  it('图上只有父节点：一叠卡片写着几条做完了几条；点开列出每一条，能点进去再回来', async () => {
    fakeWorkflow();
    await openWorkflow();
    fireEvent.click(await card(/^镜头，完成$/));
    expect(screen.queryByRole('button', { name: /^镜头 01，/, hidden: true })).toBeNull();
    expect(screen.getByText('镜头 × 2（1 完成）')).toBeTruthy();
    let panel = await screen.findByRole('complementary', { name: '节点：镜头' });
    expect(within(panel).getByText(/一共 2 条，同时跑/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /镜头 02/ }));
    panel = await screen.findByRole('complementary', { name: '节点：镜头 02' });
    fireEvent.click(within(panel).getByRole('button', { name: /属于「镜头」/ }));
    expect(await screen.findByRole('complementary', { name: '节点：镜头' })).toBeTruthy();
  });

  it('做几版的节点：看得到用了哪一版和理由，改用另一版后等确认修改', async () => {
    fakeWorkflow();
    await openWorkflow();
    expect(screen.getByText('2 版 · 用了第 2 版')).toBeTruthy();
    fireEvent.click(await card(/^海报，完成$/));
    const panel = await screen.findByRole('complementary', { name: '节点：海报' });
    expect(within(panel).getByText('用了第 2 版：第 2 版人物在画面中央')).toBeTruthy();
    expect(within(panel).getAllByRole('button', { name: '改用这一版' })).toHaveLength(1);
    fireEvent.click(within(panel).getByRole('button', { name: '改用这一版' }));
    await waitFor(() => expect(picked).toEqual({ version: 1 }));
    expect(await within(panel).findByText(/预计最多 \$0\.00/)).toBeTruthy();
  });
});
