// 画布（5.5c）：全部成果、类别和搜索、打开成果；桌面端把成果同步到电脑。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import type { TaskSummary } from '@oasis/contracts/task';
import type { OasisDesktop } from '@oasis/contracts/desktop';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { pendingOf, syncOnce, syncProgress } from '../src/desktop/sync.ts';
import { installFakeApi, json } from './fake-api.ts';

const TASK = '00000000-0000-4000-8000-0000000000f1';
const CONV = '00000000-0000-4000-8000-0000000000c1';

function artifact(
  n: number,
  path: string,
  category: ArtifactBody['category'],
  extra: Partial<ArtifactBody> = {},
): ArtifactBody {
  return {
    id: `00000000-0000-4000-8000-00000000080${n}`,
    name: path.split('/').at(-1) ?? path,
    path,
    size: 2048,
    contentType: 'text/markdown',
    category,
    deliverable: '首页文案',
    taskId: TASK,
    taskTitle: '民宿首页',
    conversationId: CONV,
    models: ['deepseek/x'],
    syncPath: `民宿首页/${path}`,
    annotations: [],
    approvedAt: null,
    createdAt: `2026-10-24T0${n}:00:00.000Z`,
    ...extra,
  };
}

const ARTIFACTS = [
  artifact(1, '首页文案.md', 'doc'),
  artifact(2, '预热短片.mp4', 'media', { contentType: 'video/mp4' }),
  artifact(3, '价格.xlsx', 'data', {
    taskTitle: '价格表',
    taskId: '00000000-0000-4000-8000-0000000000f2',
  }),
];

function fakeCanvas(list = ARTIFACTS, tasks: TaskSummary[] = []) {
  return installFakeApi({
    signedIn: true,
    extra: (method, path) => {
      if (method !== 'GET') return undefined;
      if (path === '/task/v1/tasks') return json(200, { tasks });
      if (path === '/canvas/v1/artifacts') return json(200, { artifacts: list });
      if (path === `/canvas/v1/artifacts?taskId=${TASK}`)
        return json(200, { artifacts: list.filter((a) => a.taskId === TASK) });
      const one = list.find((a) => path === `/canvas/v1/artifacts/${a.id}`);
      if (one) return json(200, one);
      if (path.endsWith('/content')) return new Response('# 山里的小木屋');
      if (path === '/task/v1/workflow/options') return json(200, { models: [], tools: [] });
      return undefined;
    },
  });
}

async function open(path: string) {
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { oasisDesktop?: unknown }).oasisDesktop;
});

describe('画布', () => {
  it('没有成果也列出运行中和已取消任务；成果类别不隐藏任务，搜索匹配任务标题', async () => {
    fakeCanvas(
      [],
      ['running', 'cancelled'].map((status, i) => ({
        id: i === 0 ? TASK : CONV,
        title: i === 0 ? '正在制作的便利店' : '已取消的街景',
        status: status as TaskSummary['status'],
        nodesDone: 4,
        nodesTotal: 10,
        spentMicro: 7_634_465,
        revisionOf: null,
        revising: false,
        createdAt: '2026-11-04T01:00:00.000Z',
      })),
    );
    await open('/canvas');
    const tasks = screen.getByRole('region', { name: '任务工作流' });
    const cancelled = await within(tasks).findByRole('link', { name: '打开工作流：已取消的街景' });
    expect(cancelled.getAttribute('href')).toBe(`/canvas/tasks/${CONV}`);
    expect(cancelled.textContent).toContain('已取消');
    expect(cancelled.textContent).toContain('4/10');
    expect(
      await within(tasks).findByRole('link', { name: '打开工作流：正在制作的便利店' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /音频和视频/ }));
    expect(within(tasks).getAllByRole('link')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('搜成果'), { target: { value: '街景' } });
    expect(within(tasks).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText(/还没有交付成果/)).toBeTruthy();
  });

  it('任务卡片上能删任务：再确认一次；还在做的会先停下，删完从列表里消失', async () => {
    let tasks: TaskSummary[] = [
      {
        id: TASK,
        title: '重复的马车',
        status: 'planning',
        nodesDone: 0,
        nodesTotal: 0,
        spentMicro: 10_700,
        revisionOf: null,
        revising: false,
        createdAt: '2026-11-04T10:24:47.000Z',
      },
    ];
    const api = installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method === 'DELETE' && path === `/task/v1/tasks/${TASK}`) {
          tasks = [];
          return new Response(null, { status: 204 });
        }
        if (method !== 'GET') return undefined;
        if (path === '/task/v1/tasks') return json(200, { tasks });
        if (path === '/canvas/v1/artifacts') return json(200, { artifacts: [] });
        return undefined;
      },
    });
    await open('/canvas');
    const card = await screen.findByRole('article', { name: '重复的马车' });
    fireEvent.click(within(card).getByRole('button', { name: '删除任务' }));
    const ask = within(card).getByRole('group', { name: '停下并彻底删除？' });
    expect(api.requests).not.toContain(`DELETE /task/v1/tasks/${TASK}`);
    fireEvent.click(within(ask).getByRole('button', { name: '取消' }));
    expect(within(card).queryByRole('group')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '删除任务' }));
    fireEvent.click(within(card).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: '重复的马车' })).toBeNull());
    expect(api.requests).toContain(`DELETE /task/v1/tasks/${TASK}`);
  });

  it('任务列表失败不挡住成果；重试后可找回工作流入口', async () => {
    let available = false;
    installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method !== 'GET') return;
        if (path === '/canvas/v1/artifacts') return json(200, { artifacts: ARTIFACTS });
        if (path === '/task/v1/tasks')
          return available
            ? json(200, {
                tasks: [
                  {
                    id: TASK,
                    title: '恢复的任务',
                    status: 'planning',
                    nodesDone: 0,
                    nodesTotal: 0,
                    spentMicro: 0,
                    revisionOf: null,
                    createdAt: '2026-11-04T01:00:00.000Z',
                  },
                ],
              })
            : json(503, { error: { code: 'unavailable', message: '不可用' } });
        if (path === '/task/v1/workflow/options') return json(200, { models: [], tools: [] });
      },
    });
    await open('/canvas');
    expect(await screen.findByRole('link', { name: '打开 首页文案.md' })).toBeTruthy();
    const retry = await screen.findByRole('button', { name: '重试加载任务' });
    available = true;
    fireEvent.click(retry);
    expect(await screen.findByRole('link', { name: '打开工作流：恢复的任务' })).toBeTruthy();
  });

  it('列出全部成果；按类别筛选，标签上有数量；能搜任务名', async () => {
    fakeCanvas();
    await open('/canvas');
    expect(await screen.findByRole('link', { name: '打开 首页文案.md' })).toBeTruthy();
    const tabs = screen.getByRole('group', { name: '成果类别' });
    fireEvent.click(within(tabs).getByRole('button', { name: /音频和视频/ }));
    expect(within(tabs).getByRole('button', { name: /音频和视频/ }).textContent).toContain('1');
    expect(screen.queryByRole('link', { name: '打开 首页文案.md' })).toBeNull();
    expect(screen.getByRole('link', { name: '打开 预热短片.mp4' })).toBeTruthy();

    fireEvent.click(within(tabs).getByRole('button', { name: /全部/ }));
    fireEvent.change(screen.getByLabelText('搜成果'), { target: { value: '价格表' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    // 浏览器里没有桌面端接口，不显示同步条
    expect(screen.queryByRole('region', { name: '同步到电脑' })).toBeNull();
  });

  it('只看某个任务的成果，可以回到全部', async () => {
    fakeCanvas();
    await open(`/canvas?task=${TASK}`);
    expect(await screen.findByRole('link', { name: /只看「民宿首页」/ })).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('打开一个成果：预览内容；顶栏只有返回、批注、下载三个图标', async () => {
    fakeCanvas();
    await open(`/canvas/artifacts/${ARTIFACTS[0]!.id}`);
    expect(await screen.findByRole('heading', { name: /首页文案\.md/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '山里的小木屋' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到画布' }).getAttribute('href')).toBe('/canvas');
    expect(screen.getByRole('button', { name: '批注' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/artifacts/${ARTIFACTS[0]!.id}/content?download=1`,
    );
    for (const gone of ['工作流', '回到私聊'])
      expect(screen.queryByRole('link', { name: gone })).toBeNull();
    expect(screen.queryByRole('button', { name: /发给 AI 团队修改|删除|批准/ })).toBeNull();
  });
});

describe('网页应用在画布里运行', () => {
  const app = [
    artifact(4, 'site/oasis-app.json', 'app', {
      nodeId: 'n1',
      contentType: 'application/json',
      application: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
    }),
    artifact(5, 'site/index.html', 'app', { nodeId: 'n1', contentType: 'text/html' }),
    artifact(6, 'site/style.css', 'app', { nodeId: 'n1', contentType: 'text/css' }),
  ];
  const content: Record<string, string> = {
    [app[1]!.id]:
      '<!doctype html><link rel="stylesheet" href="style.css"><canvas></canvas><script>spin()</script>',
    [app[2]!.id]: 'canvas{width:100%}',
  };
  const install = () =>
    installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method !== 'GET') return undefined;
        if (path === '/task/v1/tasks') return json(200, { tasks: [] });
        if (path === `/canvas/v1/artifacts?taskId=${TASK}`) return json(200, { artifacts: app });
        const one = app.find((a) => path === `/canvas/v1/artifacts/${a.id}`);
        if (one) return json(200, one);
        const file = app.find((a) => path === `/canvas/v1/artifacts/${a.id}/content`);
        if (file) return new Response(content[file.id] ?? '');
        return undefined;
      },
    });

  it('打开静态应用：入口网页带上同成果的样式，在只给脚本权限的隔离框里运行；没有平台容器预览（ADR 0021）', async () => {
    const api = install();
    await open(`/canvas/artifacts/${app[0]!.id}`);
    const frame = await screen.findByTitle('site');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('canvas{width:100%}');
    expect(doc).toContain('<script>spin()</script>');
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<script'));
    expect(api.requests.some((r) => r.includes('/preview'))).toBe(false);
    expect(screen.queryByRole('button', { name: '平台容器预览' })).toBeNull();
  });

  it('单独打开应用里的网页也会运行，并能引用同成果的文件', async () => {
    install();
    await open(`/canvas/artifacts/${app[1]!.id}`);
    const frame = await screen.findByTitle('index.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock');
    expect(frame.getAttribute('srcdoc')).toContain('canvas{width:100%}');
  });
});

describe('桌面端同步到电脑', () => {
  const bridge = (synced: string[] = [], folder: string | null = 'D:\\Oasis') => {
    const written: [string, string, number][] = [];
    const api: OasisDesktop = {
      syncStatus: vi.fn(async () => ({ folder, synced: [...synced, ...written.map((w) => w[0])] })),
      chooseSyncFolder: vi.fn(async () => folder),
      beginSyncedFile: vi.fn(async (id: string, path: string) => {
        written.push([id, path, 0]);
        return id;
      }),
      appendSyncedFile: vi.fn(async (id: string, data: Uint8Array) => {
        written.find((item) => item[0] === id)![2] += data.byteLength;
      }),
      finishSyncedFile: vi.fn(async () => undefined),
      abortSyncedFile: vi.fn(async () => undefined),
      openSyncFolder: vi.fn(async () => undefined),
    };
    return { api, written };
  };

  it('只下还没同步过的，先登记的先下，写进它算好的路径', async () => {
    const { api, written } = bridge([ARTIFACTS[0]!.id]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abc')),
    );
    await syncOnce(api, ARTIFACTS, await api.syncStatus());
    expect(written).toEqual([
      [ARTIFACTS[1]!.id, '民宿首页/预热短片.mp4', 3],
      [ARTIFACTS[2]!.id, '民宿首页/价格.xlsx', 3],
    ]);
    expect(syncProgress.get()).toMatchObject({ running: false, done: 2, total: 2, error: null });
  });

  it('同一个成果修改后原地换成新版：再同步一次，用「id@新摘要」记下并要求覆盖旧版', async () => {
    const OLD_SHA = 'a'.repeat(64);
    const NEW_SHA = 'b'.repeat(64);
    const updated = { ...ARTIFACTS[0]!, sha256: NEW_SHA, replacesSha256: OLD_SHA };
    const { api, written } = bridge([updated.id]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abc')),
    );
    expect(pendingOf([updated], { folder: 'D:\\Oasis', synced: [updated.id] })).toEqual([updated]);
    await syncOnce(api, [updated], await api.syncStatus());
    expect(written.map((w) => w[0])).toEqual([`${updated.id}@${NEW_SHA}`]);
    expect(api.beginSyncedFile).toHaveBeenCalledWith(
      `${updated.id}@${NEW_SHA}`,
      updated.syncPath,
      updated.size,
      NEW_SHA,
      OLD_SHA,
    );
    // 记下之后不再重复下载
    expect(
      pendingOf([updated], {
        folder: 'D:\\Oasis',
        synced: [updated.id, `${updated.id}@${NEW_SHA}`],
      }),
    ).toEqual([]);
  });

  it('下载失败就停下并说明，下一轮再试；没选文件夹什么也不做', async () => {
    const { api, written } = bridge();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    await syncOnce(api, ARTIFACTS, await api.syncStatus());
    expect(written).toHaveLength(0);
    expect(syncProgress.get().error).toContain('下载「首页文案.md」失败');

    const idle = bridge([], null);
    await syncOnce(idle.api, ARTIFACTS, await idle.api.syncStatus());
    expect(idle.api.beginSyncedFile).not.toHaveBeenCalled();
    expect(pendingOf(ARTIFACTS, { folder: null, synced: ARTIFACTS.map((a) => a.id) })).toEqual([]);
  });

  it('桌面端的画布上有同步条，能打开文件夹；在后台把新成果同步下来', async () => {
    const { api, written } = bridge([ARTIFACTS[0]!.id, ARTIFACTS[1]!.id]);
    (globalThis as { oasisDesktop?: OasisDesktop }).oasisDesktop = api;
    fakeCanvas();
    await open('/canvas');
    const bar = await screen.findByRole('region', { name: '同步到电脑' });
    expect(within(bar).getByText('D:\\Oasis')).toBeTruthy();
    await waitFor(() => expect(written.map((w) => w[1])).toEqual(['民宿首页/价格.xlsx']));
    expect(await within(bar).findByText('全部已同步')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: '打开文件夹' }));
    expect(api.openSyncFolder).toHaveBeenCalled();
  });
});
