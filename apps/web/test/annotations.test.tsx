// 批注与批准（ADR 0012 §9）：编号和位置的说法、成果页上标注并保存、文档意见带原文、批准记号。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import {
  formatTime,
  frameKey,
  nextNumber,
  surfaceOf,
  toRevisionNotes,
  whereOf,
} from '../src/canvas/annotations.ts';
import { installFakeApi, json } from './fake-api.ts';

const TASK = '00000000-0000-4000-8000-0000000000f1';
const note = (number: number, extra: Partial<Annotation> = {}): Annotation => ({
  id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number,
  note: `第 ${number} 处`,
  page: null,
  time: null,
  quote: null,
  shape: null,
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
    fireEvent.click(await screen.findByRole('button', { name: /^标注$/ }));
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

  it('文档：加一条意见可以带原文；批准是个开关', async () => {
    const doc = artifact('00000000-0000-4000-8000-000000000902', '首页.md', {
      contentType: 'text/markdown',
    });
    const { state } = fakeReview(doc);
    await open(doc.id);
    fireEvent.click(await screen.findByRole('button', { name: /^标注$/ }));
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

    fireEvent.click(screen.getByRole('button', { name: /^批准$/ }));
    await waitFor(() => expect(state.item.approvedAt).not.toBeNull());
    expect(await screen.findByRole('button', { name: /已批准/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /已批准/ }));
    await waitFor(() => expect(state.item.approvedAt).toBeNull());
  });
});

describe('发给 AI 修改时带上批注', () => {
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
        if (method === 'POST' && path === `/conversation/v1/conversations/${CONV}/revisions`) {
          sent.push(body);
          return json(200, { messages: [] });
        }
        if (method === 'GET' && path === `/conversation/v1/conversations/${CONV}/messages`)
          return json(200, { messages: [] });
        return undefined;
      },
    });
    await open(image.id);
    fireEvent.click(await screen.findByRole('button', { name: /发给 AI 修改/ }));
    const dialog = await screen.findByLabelText('修改「民宿首页」');
    const box = await within(dialog).findByRole('checkbox', {
      name: /带上画布上的 1 条批注/,
      hidden: true,
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '发给 AI 修改', hidden: true }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      taskId: TASK,
      request: '',
      annotations: [{ file: 'hero.png', number: 1, where: '画面右上', note: '换成夜景' }],
      attachments: [],
    });
  });
});
