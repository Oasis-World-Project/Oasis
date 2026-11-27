// 画布：一个任务一个小窗口（任务名、状态、用时、花费、做它的 AI、成果个数），点开进任务页（成品和素材，看过程、回到私聊、打包下载）、
// 群里的任务（来自哪个群、回到群、删除）、类别和搜索、只看某个私聊的、打开成果；桌面端把成果同步到电脑。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import type { OasisDesktop } from '@oasis/contracts/desktop';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { pendingOf, syncOnce, syncProgress } from '../src/desktop/sync.ts';
import { installFakeApi, json } from './fake-api.ts';

const CONV = '00000000-0000-4000-8000-0000000000c1';
const OTHER_CONV = '00000000-0000-4000-8000-0000000000c2';
const SESSION = '00000000-0000-4000-8000-0000000000f1';
const OTHER_SESSION = '00000000-0000-4000-8000-0000000000f2';
/** 两个任务：民宿首页（做完了）、价格表（在做，后开始的） */
const RUN = '00000000-0000-4000-8000-0000000000a1';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000a2';
const dm = (id: string, title: string, modelKey: string) => ({
  id,
  kind: 'dm',
  title,
  modelKey,
  createdAt: '2026-10-24T00:00:00.000Z',
  lastMessageAt: null,
  turn: null,
});
const DMS = [dm(CONV, 'Claude', 'claude'), dm(OTHER_CONV, '文心', 'ernie')];
const TASKS = [
  {
    runId: OTHER_RUN,
    conversationId: OTHER_CONV,
    room: OTHER_CONV,
    title: '价格表',
    status: 'running',
    startedAt: '2026-10-24T03:00:00.000Z',
    finishedAt: null,
    spentMicro: 20_000,
    files: [],
  },
  {
    runId: RUN,
    conversationId: CONV,
    room: CONV,
    title: '民宿首页',
    status: 'done',
    startedAt: '2026-10-24T01:00:00.000Z',
    finishedAt: '2026-10-24T01:10:00.000Z',
    spentMicro: 350_000,
    main: '预热短片.mp4',
    files: [],
  },
];

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
    conversationId: CONV,
    sessionId: SESSION,
    runId: RUN,
    task: '民宿首页',
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
    conversationId: OTHER_CONV,
    sessionId: OTHER_SESSION,
    runId: OTHER_RUN,
    task: '价格表',
    syncPath: '价格表/价格.xlsx',
  }),
  artifact(4, '素材/帧-1.png', 'doc', { contentType: 'image/png' }),
];

/** 假画布：和接口一样新的在前 */
function fakeCanvas(list = ARTIFACTS, tasks: unknown[] = TASKS) {
  const newest = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return installFakeApi({
    signedIn: true,
    dms: DMS,
    tasks,
    extra: (method, path) => {
      if (method === 'DELETE' && path.includes('/tasks/'))
        return new Response(null, { status: 204 });
      if (method !== 'GET') return undefined;
      if (path === '/canvas/v1/artifacts') return json(200, { artifacts: newest });
      if (path === `/canvas/v1/artifacts?conversationId=${CONV}`)
        return json(200, { artifacts: newest.filter((a) => a.conversationId === CONV) });
      if (path.startsWith('/canvas/v1/artifacts?sessionId='))
        return json(200, {
          artifacts: newest.filter((a) => path.endsWith(a.sessionId)),
        });
      const one = list.find((a) => path === `/canvas/v1/artifacts/${a.id}`);
      if (one) return json(200, one);
      if (path.endsWith('/content')) return new Response('# 山里的小木屋');
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
  it('一个任务一个小窗口，最近的在前：任务名、状态、用时、花费、做它的 AI、成果个数；点开进任务页', async () => {
    fakeCanvas();
    await open('/canvas');
    const home = await screen.findByRole('link', { name: '打开任务 民宿首页' });
    const price = screen.getByRole('link', { name: '打开任务 价格表' });
    expect(price.compareDocumentPosition(home) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(home.getAttribute('href')).toBe(`/canvas/tasks/${RUN}`);
    expect(within(home).getByText('已完成')).toBeTruthy();
    expect(home.textContent).toContain('用时 10 分 0 秒');
    expect(home.textContent).toMatch(/\$0\.35/);
    expect(within(home).getByText('Claude')).toBeTruthy();
    expect(home.textContent).toContain('成品 2 · 素材 1');
    // 成果不在首页展开
    expect(screen.queryByRole('link', { name: '打开 首页文案.md' })).toBeNull();
    expect(within(price).getByText('进行中')).toBeTruthy();
    expect(within(price).getByText('文心')).toBeTruthy();
    // 浏览器里没有桌面端接口，不显示同步条
    expect(screen.queryByRole('region', { name: '同步到电脑' })).toBeNull();
  });

  it('任务页：成品和素材分开，看过程、回到私聊、打包下载；没有成果的在做的任务说还在做', async () => {
    fakeCanvas();
    await open(`/canvas/tasks/${RUN}`);
    const home = await screen.findByRole('region', { name: '民宿首页' });
    expect(within(home).getByRole('heading', { name: '成品' })).toBeTruthy();
    expect(within(home).getByRole('heading', { name: /素材/ }).textContent).toContain('1');
    expect(within(home).getAllByRole('article')).toHaveLength(3);
    // AI 自己标的主成果排在成品的最前面（没标就按名字排）
    expect(within(home).getAllByRole('article')[0]!.textContent).toContain('预热短片.mp4');
    expect(within(home).getByRole('link', { name: '看过程' }).getAttribute('href')).toBe(
      `/dms/${CONV}?task=${RUN}`,
    );
    expect(within(home).getByRole('link', { name: '回到私聊' }).getAttribute('href')).toBe(
      `/dms/${CONV}`,
    );
    expect(within(home).getByRole('link', { name: '打包下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/runs/${RUN}/archive`,
    );
    expect(screen.getByRole('link', { name: '回到画布' }).getAttribute('href')).toBe('/canvas');

    cleanup();
    await open(`/canvas/tasks/${OTHER_RUN}`);
    const price = await screen.findByRole('region', { name: '价格表' });
    expect(within(price).getByRole('link', { name: '看进度' })).toBeTruthy();
  });

  it('群里的任务（自己是群主）：写着来自哪个群、哪个 AI 做的；看过程去群的工作台，回到群；删掉后回到画布', async () => {
    const GROUP = '00000000-0000-4000-8000-0000000000d1';
    const SEAT = '00000000-0000-4000-8000-0000000000d2';
    const GROUP_RUN = '00000000-0000-4000-8000-0000000000a3';
    const api = fakeCanvas(
      [
        ...ARTIFACTS,
        artifact(5, '流程.md', 'doc', {
          conversationId: SEAT,
          sessionId: SEAT,
          runId: GROUP_RUN,
          task: '写流程',
        }),
      ],
      [
        ...TASKS,
        {
          runId: GROUP_RUN,
          conversationId: SEAT,
          room: GROUP,
          title: '写流程',
          status: 'done',
          startedAt: '2026-10-24T02:00:00.000Z',
          finishedAt: '2026-10-24T02:01:00.000Z',
          spentMicro: 1_000,
          files: [],
          group: { id: GROUP, title: '发布会', key: 'ernie' },
        },
      ],
    );
    await open('/canvas');
    const tile = await screen.findByRole('link', { name: '打开任务 写流程' });
    expect(tile.textContent).toContain('来自群：发布会');
    expect(within(tile).getByText('文心')).toBeTruthy();

    cleanup();
    await open(`/canvas/tasks/${GROUP_RUN}`);
    const panel = await screen.findByRole('region', { name: '写流程' });
    expect(within(panel).getByRole('link', { name: '看过程' }).getAttribute('href')).toBe(
      `/groups/${GROUP}?task=${GROUP_RUN}`,
    );
    expect(within(panel).getByRole('link', { name: '回到群' }).getAttribute('href')).toBe(
      `/groups/${GROUP}`,
    );
    fireEvent.click(within(panel).getByRole('button', { name: '删除' }));
    fireEvent.click(within(panel).getByRole('button', { name: '删掉' }));
    await screen.findByRole('heading', { name: '画布' });
    expect(api.requests).toContain(`DELETE /conversation/v1/groups/${GROUP}/tasks/${GROUP_RUN}`);
  });

  it('按类别筛选，标签上有数量；能搜任务名', async () => {
    fakeCanvas();
    await open('/canvas');
    expect(await screen.findByRole('link', { name: '打开任务 价格表' })).toBeTruthy();
    const tabs = screen.getByRole('group', { name: '成果类别' });
    fireEvent.click(within(tabs).getByRole('button', { name: /音频和视频/ }));
    expect(within(tabs).getByRole('button', { name: /音频和视频/ }).textContent).toContain('1');
    expect(screen.getByRole('link', { name: '打开任务 民宿首页' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '打开任务 价格表' })).toBeNull();

    fireEvent.click(within(tabs).getByRole('button', { name: /全部/ }));
    fireEvent.change(screen.getByLabelText('搜成果'), { target: { value: '价格表' } });
    expect(screen.getByRole('link', { name: '打开任务 价格表' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '打开任务 民宿首页' })).toBeNull();
  });

  it('只看某个私聊的任务，可以回到全部', async () => {
    fakeCanvas();
    await open(`/canvas?conversation=${CONV}`);
    const only = await screen.findByRole('link', { name: /只看「Claude」/ });
    expect(only.getAttribute('href')).toBe('/canvas');
    expect(await screen.findByRole('link', { name: '打开任务 民宿首页' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '打开任务 价格表' })).toBeNull();
  });

  it('还没有成果：说去私聊里让 AI 做', async () => {
    fakeCanvas([], []);
    await open('/canvas');
    expect(await screen.findByText(/还没有成果/)).toBeTruthy();
  });

  it('打开一个成果：预览内容；顶栏是回画布、哪个任务的哪个文件、看过程、下载、「编辑」；下面写谁做的', async () => {
    fakeCanvas();
    await open(`/canvas/artifacts/${ARTIFACTS[0]!.id}`);
    expect(await screen.findByRole('heading', { name: /民宿首页/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '山里的小木屋' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到画布' }).getAttribute('href')).toBe('/canvas');
    expect(screen.getByRole('button', { name: '编辑' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/artifacts/${ARTIFACTS[0]!.id}/content?download=1`,
    );
    expect(screen.getByText(/做的 · .*放进画布/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '看过程' }).getAttribute('href')).toBe(
      `/dms/${CONV}?task=${RUN}`,
    );
    expect(screen.queryByRole('button', { name: /让 AI 改|删除|批准/ })).toBeNull();
  });

  it('做它的 AI 正在做一轮：「看过程」写着它正在做；进了「编辑」也不能让它改', async () => {
    installFakeApi({
      signedIn: true,
      dms: [
        {
          ...DMS[0]!,
          turn: {
            runId: '00000000-0000-4000-8000-0000000000b1',
            startedAt: '2026-10-24T09:00:00.000Z',
          },
        },
      ],
      extra: (method, path) => {
        if (method !== 'GET') return undefined;
        if (path === `/canvas/v1/artifacts/${ARTIFACTS[0]!.id}`) return json(200, ARTIFACTS[0]);
        if (path.startsWith('/canvas/v1/artifacts?')) return json(200, { artifacts: ARTIFACTS });
        if (path.endsWith('/content')) return new Response('# 山里的小木屋');
        return undefined;
      },
    });
    await open(`/canvas/artifacts/${ARTIFACTS[0]!.id}`);
    const busy = await screen.findByRole('link', { name: '它正在做，看进度' });
    expect(busy.getAttribute('href')).toBe(`/dms/${CONV}?task=${RUN}`);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.getByRole('button', { name: '它正在做…' })).toHaveProperty('disabled', true);
  });
});

describe('网页应用在画布里运行', () => {
  const app = [
    artifact(4, 'site/oasis-app.json', 'app', {
      contentType: 'application/json',
      application: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
    }),
    artifact(5, 'site/index.html', 'app', { contentType: 'text/html' }),
    artifact(6, 'site/style.css', 'app', { contentType: 'text/css' }),
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
        if (path === `/canvas/v1/artifacts?sessionId=${SESSION}`)
          return json(200, { artifacts: app });
        const one = app.find((a) => path === `/canvas/v1/artifacts/${a.id}`);
        if (one) return json(200, one);
        const file = app.find((a) => path === `/canvas/v1/artifacts/${a.id}/content`);
        if (file) return new Response(content[file.id] ?? '');
        return undefined;
      },
    });

  it('打开静态应用：入口网页带上同话题的样式，在只给脚本权限的隔离框里运行；没有平台容器预览', async () => {
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

  it('单独打开应用里的网页也会运行，并能引用同话题的文件', async () => {
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
      [ARTIFACTS[2]!.id, '价格表/价格.xlsx', 3],
      [ARTIFACTS[3]!.id, '民宿首页/素材/帧-1.png', 3],
    ]);
    expect(syncProgress.get()).toMatchObject({ running: false, done: 3, total: 3, error: null });
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
    await waitFor(() =>
      expect(written.map((w) => w[1])).toEqual(['价格表/价格.xlsx', '民宿首页/素材/帧-1.png']),
    );
    expect(await within(bar).findByText('全部已同步')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: '打开文件夹' }));
    expect(api.openSyncFolder).toHaveBeenCalled();
  });
});
