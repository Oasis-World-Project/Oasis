// 批注（ADR 0012 §9、0009 §18）：编号和位置的说法、顶栏批注图标进入标注并保存、文档意见带原文、运行中应用截图批注。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import {
  formatTime,
  frameKey,
  frameOrder,
  nextNumber,
  surfaceOf,
  toRevisionNotes,
  whereOf,
} from '../src/canvas/annotations.ts';
import { installFakeApi, json, revisingTask } from './fake-api.ts';

const TASK = '00000000-0000-4000-8000-0000000000f1';
const note = (number: number, extra: Partial<Annotation> = {}): Annotation => ({
  id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number,
  note: `第 ${number} 处`,
  page: null,
  time: null,
  quote: null,
  shape: null,
  frame: null,
  ...extra,
});

describe('批注的编号和位置', () => {
  it('编号用最小的空位；位置说成第几页、几分几秒、画面哪一块', () => {
    expect(nextNumber([note(1), note(3)])).toBe(2);
    expect(nextNumber(Array.from({ length: 50 }, (_, i) => note(i + 1)))).toBeNull();
    expect(formatTime(75.9)).toBe('1:15');
    expect(whereOf(note(1, { page: 3, shape: { kind: 'pin', x: 0.1, y: 0.1 } }))).toBe(
      '第 3 页 画面左上',
    );
    expect(
      whereOf(note(1, { time: 12, shape: { kind: 'ellipse', x: 0.4, y: 0.7, w: 0.2, h: 0.2 } })),
    ).toBe('0:12 画面下');
    expect(whereOf(note(1, { shape: { kind: 'pin', x: 0.5, y: 0.5 } }))).toBe('画面中间');
    expect(frameKey(note(1, { page: 2 }))).toBe('p2');
    expect(surfaceOf('presentation', true)).toBe('pdf');
    expect(surfaceOf('presentation', false)).toBe('text');
    expect(surfaceOf('document', false)).toBe('text');
    // 运行中应用的截图：按第一次出现的编号排第几张，位置说成「截图 N 画面…」
    const A = '40000000-0000-4000-8000-00000000000a';
    const B = '40000000-0000-4000-8000-00000000000b';
    const shots = [
      note(3, { frame: A, shape: { kind: 'pin', x: 0.1, y: 0.9 } }),
      note(1, { frame: B, shape: { kind: 'pin', x: 0.5, y: 0.5 } }),
      note(2, { frame: A }),
    ];
    expect(frameOrder(shots)).toEqual([B, A]);
    expect(whereOf(shots[0]!, frameOrder(shots))).toBe('截图 2 画面左下');
    expect(frameKey(shots[0]!)).toBe(`f${A}`);
  });

  it('发给 AI 的批注按编号排好，带上原文和截图名', () => {
    const notes = toRevisionNotes(
      [
        {
          name: 'hero.png',
          annotations: [note(2, { shape: { kind: 'pin', x: 0.9, y: 0.9 } }), note(1)],
        },
        { name: 'a.md', annotations: [note(1, { quote: '原文' })] },
      ],
      (file, a) => (file === 'hero.png' && a.number === 2 ? '批注-hero.png' : undefined),
    );
    expect(notes).toEqual([
      { file: 'hero.png', number: 1, where: '', note: '第 1 处' },
      {
        file: 'hero.png',
        number: 2,
        where: '画面右下',
        note: '第 2 处',
        snapshot: '批注-hero.png',
      },
      { file: 'a.md', number: 1, where: '', note: '第 1 处', quote: '原文' },
    ]);
  });
});

function artifact(id: string, path: string, extra: Partial<ArtifactBody> = {}): ArtifactBody {
  return {
    id,
    name: path,
    path,
    size: 100,
    contentType: 'image/png',
    category: 'doc',
    deliverable: '首屏图',
    taskId: TASK,
    nodeId: '00000000-0000-4000-8000-0000000000a1',
    taskTitle: '民宿首页',
    conversationId: null,
    models: [],
    syncPath: `民宿首页/${path}`,
    annotations: [],
    approvedAt: null,
    createdAt: '2026-10-31T08:00:00.000Z',
    ...extra,
  };
}

/** 一个假画布：记着成果，PUT 批注、批准都改它 */
function fakeReview(item: ArtifactBody) {
  const state = { item };
  const api = installFakeApi({
    signedIn: true,
    extra: (method, path, body) => {
      const base = `/canvas/v1/artifacts/${item.id}`;
      if (method === 'GET' && path === base) return json(200, state.item);
      if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
        return json(200, { artifacts: [state.item] });
      if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
      if (method === 'GET' && path.endsWith('/content'))
        return new Response('# 首页\n\n山里的小木屋');
      if (method === 'PUT' && path === `${base}/annotations`) {
        state.item = { ...state.item, ...(body as { annotations: Annotation[] }) };
        return json(200, state.item);
      }
      if (path === `${base}/approval`) {
        state.item = {
          ...state.item,
          approvedAt: method === 'POST' ? '2026-10-31T09:00:00.000Z' : null,
        };
        return json(200, state.item);
      }
      return undefined;
    },
  });
  return { api, state };
}

async function open(id: string) {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/canvas/artifacts/${id}`] }),
  });
  await act(() => router.load());
  render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('成果页上标注', () => {
  it('图片：标注 → 点一下 → 写意见 → 保存；画面上出现编号，点编号才显示意见', async () => {
    const image = artifact('00000000-0000-4000-8000-000000000901', 'hero.png');
    const { api, state } = fakeReview(image);
    await open(image.id);
    fireEvent.click(await screen.findByRole('button', { name: '批注' }));
    fireEvent.click(screen.getByRole('button', { name: /点/ }));
    const surface = screen.getByLabelText('在画面上标注');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(surface, { clientX: 150, clientY: 25, pointerId: 1 });
    const panel = screen.getByRole('complementary', { name: '批注' });
    expect(within(panel).getByText(/第 1 条 · 画面右上/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('这里要怎么改'), {
      target: { value: '换成夜景' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '加上' }));
    await waitFor(() => expect(state.item.annotations).toHaveLength(1));
    expect(state.item.annotations[0]).toMatchObject({
      number: 1,
      note: '换成夜景',
      shape: { kind: 'pin', x: 0.75, y: 0.25 },
    });
    expect(api.bodies.some((b) => b.path.endsWith('/annotations'))).toBe(true);
    const badge = await screen.findByRole('button', { name: '第 1 条批注' });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(badge);
    expect(screen.getByRole('note').textContent).toBe('换成夜景');
    // 标注时可以删
    fireEvent.click(within(panel).getByRole('button', { name: '删除批注 1' }));
    await waitFor(() => expect(state.item.annotations).toHaveLength(0));
  });

  it('文档：加一条意见可以带原文；顶栏只有返回、批注、下载，没有批准', async () => {
    const doc = artifact('00000000-0000-4000-8000-000000000902', '首页.md', {
      contentType: 'text/markdown',
    });
    const { state } = fakeReview(doc);
    await open(doc.id);
    fireEvent.click(await screen.findByRole('button', { name: '批注' }));
    fireEvent.click(screen.getByRole('button', { name: /加一条意见/ }));
    const panel = screen.getByRole('complementary', { name: '批注' });
    fireEvent.change(within(panel).getByLabelText('这里要怎么改'), {
      target: { value: '这句太长' },
    });
    fireEvent.change(within(panel).getByRole('textbox', { name: /引用原文/ }), {
      target: { value: '山里的小木屋' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '加上' }));
    await waitFor(() =>
      expect(state.item.annotations[0]).toMatchObject({ quote: '山里的小木屋', shape: null }),
    );

    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    for (const gone of ['工作流', '回到私聊', '上一个', '下一个', '打包下载'])
      expect(screen.queryByRole('link', { name: gone })).toBeNull();
    expect(screen.getByRole('link', { name: '回到画布' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/artifacts/${doc.id}/content?download=1`,
    );
  });
});

describe('发给 AI 团队修改时带上批注', () => {
  it('不写意见只带批注也能发；截图合成不了时批注照样带上，只是没有截图', async () => {
    const CONV = '00000000-0000-4000-8000-0000000000c1';
    const image = artifact('00000000-0000-4000-8000-000000000903', 'hero.png', {
      annotations: [note(1, { note: '换成夜景', shape: { kind: 'pin', x: 0.8, y: 0.2 } })],
    });
    const sent: unknown[] = [];
    installFakeApi({
      signedIn: true,
      dms: [
        {
          id: CONV,
          kind: 'dm',
          title: 'Claude',
          modelKey: 'claude',
          createdAt: image.createdAt,
          lastMessageAt: null,
        },
      ],
      extra: (method, path, body) => {
        if (method === 'GET' && path === `/canvas/v1/artifacts/${image.id}`)
          return json(200, image);
        if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
          return json(200, { artifacts: [image] });
        if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
        if (method === 'POST' && path === `/task/v1/tasks/${TASK}/revisions`) {
          sent.push(body);
          return json(200, revisingTask(TASK, '民宿首页'));
        }
        if (method === 'GET' && path === `/conversation/v1/conversations/${CONV}/messages`)
          return json(200, { messages: [] });
        return undefined;
      },
    });
    await open(image.id);
    fireEvent.click(await screen.findByRole('button', { name: '批注' }));
    fireEvent.click(await screen.findByRole('button', { name: /发给 AI 团队修改/ }));
    const dialog = await screen.findByLabelText('修改「民宿首页」');
    const box = await within(dialog).findByRole('checkbox', {
      name: /带上画布上的 1 条批注/,
      hidden: true,
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '发给 AI 团队修改', hidden: true }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      request: '',
      annotations: [{ file: 'hero.png', number: 1, where: '画面右上', note: '换成夜景' }],
      parameters: [],
      attachments: [],
      nodeIds: [image.nodeId],
    });
  });
});

describe('运行中的应用上批注（桌面版）', () => {
  const FRAME = '50000000-0000-4000-8000-000000000001';
  class FakeXhr {
    static sent: string[] = [];
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    withCredentials = false;
    status = 0;
    responseText = '';
    private url = '';
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      FakeXhr.sent.push(this.url);
      this.status = 201;
      this.responseText = JSON.stringify({
        id: FRAME,
        name: '批注截图.png',
        size: 4,
        contentType: 'image/png',
        createdAt: '2026-11-04T15:00:00.000Z',
      });
      queueMicrotask(() => this.onload?.());
    }
  }
  afterEach(() => {
    delete (globalThis as { oasisDesktop?: unknown }).oasisDesktop;
    FakeXhr.sent = [];
  });

  it('点批注先截下运行框的画面再弹出侧栏；在截图上点一下写意见，批注记住是哪张截图；能回到操作', async () => {
    const app = artifact('00000000-0000-4000-8000-000000000910', 'site/oasis-app.json', {
      contentType: 'application/json',
      application: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
    });
    const entry = artifact('00000000-0000-4000-8000-000000000911', 'site/index.html', {
      contentType: 'text/html',
    });
    const state = { item: app };
    const capturePage = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
    (globalThis as { oasisDesktop?: unknown }).oasisDesktop = { capturePage };
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    installFakeApi({
      signedIn: true,
      extra: (method, path, body) => {
        const base = `/canvas/v1/artifacts/${app.id}`;
        if (method === 'GET' && path === base) return json(200, state.item);
        if (method === 'GET' && path.startsWith('/canvas/v1/artifacts?'))
          return json(200, { artifacts: [state.item, entry] });
        if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
        if (method === 'GET' && path === `/canvas/v1/artifacts/${entry.id}/content`)
          return new Response('<!doctype html><canvas></canvas><script>spin()</script>');
        if (method === 'PUT' && path === `${base}/annotations`) {
          state.item = { ...state.item, ...(body as { annotations: Annotation[] }) };
          return json(200, state.item);
        }
        return undefined;
      },
    });
    await open(app.id);
    const frame = await screen.findByTitle('site');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      top: 120,
      width: 900,
      height: 600,
      right: 940,
      bottom: 720,
      x: 40,
      y: 120,
      toJSON: () => ({}),
    });
    fireEvent.click(screen.getByRole('button', { name: '批注' }));
    // 截的是运行框那一块，截好、存好之后才出侧栏
    await waitFor(() =>
      expect(capturePage).toHaveBeenCalledWith({ x: 40, y: 120, width: 900, height: 600 }),
    );
    const shot = await screen.findByAltText('批注截图');
    expect(shot.getAttribute('src')).toBe(`/api/canvas/v1/uploads/${FRAME}`);
    expect(FakeXhr.sent[0]).toContain('/api/canvas/v1/uploads?name=');
    const panel = await screen.findByRole('complementary', { name: '批注' });
    // 应用没被卸载，只是被截图盖住
    expect(document.querySelector('iframe[title="site"]')).toBe(frame);
    fireEvent.click(screen.getByRole('button', { name: /点/ }));
    const surface = screen.getByLabelText('在画面上标注');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(surface, { clientX: 50, clientY: 80, pointerId: 1 });
    expect(within(panel).getByText(/第 1 条 · 截图 1 画面左下/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('这里要怎么改'), {
      target: { value: '车轮换成金色' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: '加上' }));
    await waitFor(() =>
      expect(state.item.annotations[0]).toMatchObject({
        note: '车轮换成金色',
        frame: FRAME,
        shape: { kind: 'pin', x: 0.25, y: 0.8 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '回到操作' }));
    expect(screen.queryByAltText('批注截图')).toBeNull();
    expect(screen.getByRole('button', { name: '截取当前画面' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: '批注' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /发给 AI 团队修改/ })).toBeTruthy();
    // 应用的下载是整个应用
    expect(screen.getByRole('link', { name: '下载' }).getAttribute('href')).toBe(
      `/api/canvas/v1/tasks/${TASK}/archive`,
    );
  });

  it('浏览器里没有桌面端截图：应用照常运行，批注只能写意见', async () => {
    const page = artifact('00000000-0000-4000-8000-000000000920', 'site/index.html', {
      contentType: 'text/html',
    });
    fakeReview(page);
    await open(page.id);
    fireEvent.click(await screen.findByRole('button', { name: '批注' }));
    expect(await screen.findByRole('button', { name: /加一条意见/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '截取当前画面' })).toBeNull();
  });
});
