// 画布（5.5c）：全部成果、类别和搜索、打开成果；桌面端把成果同步到电脑。
import type { ArtifactBody } from '@oasis/contracts/canvas';
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

function fakeCanvas(list = ARTIFACTS) {
  return installFakeApi({
    signedIn: true,
    extra: (method, path) => {
      if (method !== 'GET') return undefined;
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

  it('打开一个成果：预览内容，能去工作流、回到私聊、下载', async () => {
    fakeCanvas();
    await open(`/canvas/artifacts/${ARTIFACTS[0]!.id}`);
    expect(await screen.findByRole('heading', { name: '首页文案.md' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '山里的小木屋' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '工作流' }).getAttribute('href')).toBe(
      `/canvas/tasks/${TASK}`,
    );
    expect(screen.getByRole('link', { name: '回到私聊' }).getAttribute('href')).toBe(
      `/dms/${CONV}`,
    );
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/artifacts/${ARTIFACTS[0]!.id}/content?download=1`,
    );
  });
});

describe('桌面端同步到电脑', () => {
  const bridge = (synced: string[] = [], folder: string | null = 'D:\\Oasis') => {
    const written: [string, string, number][] = [];
    const api: OasisDesktop = {
      syncStatus: vi.fn(async () => ({ folder, synced: [...synced, ...written.map((w) => w[0])] })),
      chooseSyncFolder: vi.fn(async () => folder),
      writeSyncedFile: vi.fn(async (id: string, path: string, data: ArrayBuffer) => {
        written.push([id, path, data.byteLength]);
      }),
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
    expect(idle.api.writeSyncedFile).not.toHaveBeenCalled();
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
