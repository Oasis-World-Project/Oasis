// 成果页的「编辑」：编号和位置的说法、发给 AI 的那段话；在图片上点一处记下、删到一条不剩；文字选一段；
// 运行着的应用切到「选取」后点，记下点的是哪个按钮；「让 AI 改」把要改的地方发进做它的私聊。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { formatTime, nextNumber, revisionText, surfaceOf, whereOf } from '../src/canvas/edits.ts';
import { installFakeApi, json } from './fake-api.ts';

/** 做这些成果的私聊和话题 */
const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';
const SESSION = '00000000-0000-4000-8000-0000000000f1';
const note = (number: number, extra: Partial<Annotation> = {}): Annotation => ({
  id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  number,
  note: `第 ${number} 处`,
  page: null,
  time: null,
  quote: null,
  shape: null,
  target: null,
  ...extra,
});

describe('要改的地方：编号、位置、发给 AI 的话', () => {
  it('编号用最小的空位；位置说成第几页、几分几秒、画面哪一块，选中了东西就说是什么', () => {
    expect(nextNumber([])).toBe(1);
    expect(nextNumber([note(1), note(3)])).toBe(2);
    expect(nextNumber(Array.from({ length: 50 }, (_, i) => note(i + 1)))).toBeNull();
    expect(formatTime(72.6)).toBe('1:12');
    expect(whereOf(note(1, { page: 2, shape: { kind: 'pin', x: 0.1, y: 0.1 } }))).toBe(
      '第 2 页 · 画面左上',
    );
    expect(
      whereOf(note(1, { time: 9, shape: { kind: 'box', x: 0.3, y: 0.3, w: 0.4, h: 0.4 } })),
    ).toBe('0:09 · 画面中间');
    expect(
      whereOf(note(1, { shape: { kind: 'pin', x: 0.9, y: 0.9 }, target: '按钮「立即预约」' })),
    ).toBe('按钮「立即预约」');
    expect(whereOf(note(1, { quote: '山里的小木屋' }))).toBe('选中的一段');
    expect(whereOf(note(1))).toBe('整体');
    // 怎么指着改：运行着的网页、应用、3D 是「选取」，Word、PPT 有配套 PDF 时按页
    expect(surfaceOf('page', false, false)).toBe('live');
    expect(surfaceOf('model', false, false)).toBe('live');
    expect(surfaceOf('document', true, false)).toBe('pdf');
    expect(surfaceOf('document', false, false)).toBe('text');
    expect(surfaceOf('image', false, true)).toBe('live');
  });

  it('发给 AI 的话：整体的要求，每处一行（按编号，带原文），参数一行一项', () => {
    expect(
      revisionText(
        '整体再暖一点',
        [
          {
            name: 'hero.png',
            annotations: [
              note(2, { note: '换成夜景', shape: { kind: 'pin', x: 0.9, y: 0.9 } }),
              note(1, { note: '改短', quote: '原文' }),
            ],
          },
        ],
        [{ file: 'hero.png', name: '亮度', value: '+10%' }],
      ),
    ).toBe(
      [
        '整体再暖一点',
        '要改的地方：',
        '1.「hero.png」选中的一段：改短（原文「原文」）',
        '2.「hero.png」画面右下：换成夜景',
        '参数：',
        '「hero.png」亮度：+10%',
      ].join('\n'),
    );
    expect(revisionText('改一下', [])).toBe('改一下');
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
    conversationId: CONVERSATION,
    sessionId: SESSION,
    runId: '00000000-0000-4000-8000-0000000000a1',
    task: '民宿首页',
    models: [],
    syncPath: `民宿首页/${path}`,
    annotations: [],
    approvedAt: null,
    createdAt: '2026-10-31T08:00:00.000Z',
    ...extra,
  };
}

const DM = {
  id: CONVERSATION,
  kind: 'dm',
  title: 'Claude',
  modelKey: 'claude',
  createdAt: '2026-10-31T08:00:00.000Z',
  lastMessageAt: null,
  turn: null,
};

/** 一个假画布：记着成果，PUT 要改的地方就改它；发进私聊的话记下来 */
function fakeCanvas(item: ArtifactBody, others: ArtifactBody[] = []) {
  const state = { item, sent: [] as unknown[] };
  const api = installFakeApi({
    signedIn: true,
    dms: [DM],
    extra: (method, path, body) => {
      const base = `/canvas/v1/artifacts/${item.id}`;
      if (method === 'GET' && path === base) return json(200, state.item);
      if (method === 'GET' && path.endsWith('/content'))
        return new Response(
          others[0] && path.includes(others[0].id)
            ? '<button>立即预约</button>'
            : '# 首页\n\n山里的小木屋',
        );
      if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
        return json(200, { artifacts: [state.item, ...others] });
      if (method === 'PUT' && path === `${base}/annotations`) {
        state.item = { ...state.item, ...(body as { annotations: Annotation[] }) };
        return json(200, state.item);
      }
      const messages = `/conversation/v1/conversations/${CONVERSATION}/messages`;
      if (method === 'POST' && path === messages) {
        state.sent.push(body);
        return json(201, { messages: [], turn: null });
      }
      if (method === 'GET' && path === messages) return json(200, { messages: [], turn: null });
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

/** 画面有大小（jsdom 里都是 0）：200 × 100 */
const sized = (element: Element) =>
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
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
/** 在画面上点一下（按下再抬起） */
function tap(surface: Element, x: number, y: number) {
  fireEvent.pointerDown(surface, { clientX: x, clientY: y, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: x, clientY: y, pointerId: 1 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('成果页的「编辑」', () => {
  it('图片：点「编辑」→ 在图上点一下 → 说怎么改 →「记下」；画面上和右边清单里是同一个编号；能删到一条不剩', async () => {
    const image = artifact('00000000-0000-4000-8000-000000000901', 'hero.png');
    const { state } = fakeCanvas(image);
    await open(image.id);
    // 顶栏一直在；没进「编辑」时没有右边那一栏
    expect(await screen.findByRole('link', { name: '看过程' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: '要改的地方' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const panel = screen.getByRole('complementary', { name: '要改的地方' });
    const surface = screen.getByLabelText('在画面上点一下或拖一个框');
    sized(surface);
    tap(surface, 150, 25);
    const form = screen.getByRole('form', { name: '这里要怎么改' });
    expect(form.textContent).toContain('选中了：画面右上');
    // 常用的说法点一下就填上
    fireEvent.click(within(form).getByRole('button', { name: '去掉' }));
    fireEvent.change(within(form).getByRole('textbox', { name: '这里要怎么改' }), {
      target: { value: '换成夜景' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '记下' }));
    await waitFor(() => expect(state.item.annotations).toHaveLength(1));
    expect(state.item.annotations[0]).toMatchObject({
      number: 1,
      note: '换成夜景',
      shape: { kind: 'pin', x: 0.75, y: 0.25 },
      target: null,
    });
    expect(await screen.findByRole('button', { name: '第 1 处：画面右上' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '跳到第 1 处：画面右上' })).toBeTruthy();
    expect(within(panel).getByText('换成夜景')).toBeTruthy();
    // 拖一下是一个框
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 80, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 80, clientY: 90, pointerId: 1 });
    fireEvent.change(screen.getByRole('textbox', { name: '这里要怎么改' }), {
      target: { value: '调亮一点' },
    });
    fireEvent.click(screen.getByRole('button', { name: '记下' }));
    await waitFor(() => expect(state.item.annotations).toHaveLength(2));
    expect(state.item.annotations[1]).toMatchObject({
      number: 2,
      shape: { kind: 'box', x: 0.1, y: 0.6, w: 0.3, h: 0.3 },
    });
    // 一条一条删，最后一条也删得掉
    fireEvent.click(within(panel).getByRole('button', { name: '不改第 1 处了' }));
    await waitFor(() => expect(state.item.annotations).toHaveLength(1));
    fireEvent.click(within(panel).getByRole('button', { name: '不改第 2 处了' }));
    await waitFor(() => expect(state.item.annotations).toEqual([]));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('文字：选中一段原文再点「改这一段」，记下的是原文；没选就提醒先选', async () => {
    const doc = artifact('00000000-0000-4000-8000-000000000902', '首页.md', {
      contentType: 'text/markdown',
    });
    const { state } = fakeCanvas(doc);
    await open(doc.id);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const quoted = await screen.findByText('山里的小木屋');
    fireEvent.click(screen.getByRole('button', { name: '改这一段' }));
    expect(screen.getByRole('status').textContent).toContain('先在上面选中');
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '山里的小木屋',
      anchorNode: quoted.firstChild,
    } as unknown as Selection);
    fireEvent.click(screen.getByRole('button', { name: '改这一段' }));
    const form = screen.getByRole('form', { name: '这里要怎么改' });
    expect(form.textContent).toContain('选中了：选中的一段');
    fireEvent.change(within(form).getByRole('textbox', { name: '这里要怎么改' }), {
      target: { value: '改短' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '记下' }));
    await waitFor(() =>
      expect(state.item.annotations[0]).toMatchObject({
        note: '改短',
        quote: '山里的小木屋',
        shape: null,
      }),
    );
  });

  it('运行着的应用：「操作」时照常用，切到「选取」后点一下，记下点的是哪个按钮', async () => {
    const entry = artifact('00000000-0000-4000-8000-000000000912', 'site/index.html', {
      contentType: 'text/html',
    });
    const app = artifact('00000000-0000-4000-8000-000000000911', 'site/oasis-app.json', {
      name: 'oasis-app.json',
      category: 'app',
      application: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
    });
    const { state } = fakeCanvas(app, [entry]);
    await open(app.id);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const modes = screen.getByRole('radiogroup', { name: '点一下是操作还是选取' });
    fireEvent.click(within(modes).getByRole('radio', { name: '操作' }));
    expect(screen.queryByLabelText('在画面上点一下或拖一个框')).toBeNull();
    fireEvent.click(within(modes).getByRole('radio', { name: '选取' }));
    const surface = screen.getByLabelText('在画面上点一下或拖一个框');
    sized(surface);
    const frame = await waitFor(() => {
      const found = document.querySelector('iframe');
      if (!found?.contentWindow) throw new Error('运行框还没出来');
      return found;
    });
    sized(frame);
    // 运行框里的页面答：这一点上是「立即预约」按钮
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
      const { id } = (message as { oasisPick: { id: string } }).oasisPick;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { oasisPicked: { id, label: '按钮「立即预约」' } },
          source: frame.contentWindow,
        }),
      );
    });
    tap(surface, 100, 50);
    const form = await screen.findByRole('form', { name: '这里要怎么改' });
    expect(form.textContent).toContain('选中了：按钮「立即预约」');
    fireEvent.change(within(form).getByRole('textbox', { name: '这里要怎么改' }), {
      target: { value: '改成「马上订」' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '记下' }));
    await waitFor(() =>
      expect(state.item.annotations[0]).toMatchObject({
        target: '按钮「立即预约」',
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
      }),
    );
  });

  it('「让 AI 改」：要改的地方和整体的要求写成一段话，带着这份成果发进做它的私聊，发完回到私聊；不带截图', async () => {
    const image = artifact('00000000-0000-4000-8000-000000000903', 'hero.png', {
      annotations: [note(1, { note: '换成夜景', shape: { kind: 'pin', x: 0.8, y: 0.2 } })],
    });
    const { state } = fakeCanvas(image);
    await open(image.id);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const panel = screen.getByRole('complementary', { name: '要改的地方' });
    expect(await within(panel).findByText(/交给 Claude/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: '让 AI 改 · 1 处' }));
    await waitFor(() => expect(state.sent).toHaveLength(1));
    expect(state.sent[0]).toEqual({
      content: '改一下「hero.png」\n要改的地方：\n1.「hero.png」画面右上：换成夜景',
      attachments: [],
      artifacts: [image.id],
    });
    expect(await screen.findByRole('region', { name: '聊天' })).toBeTruthy();
  });
});
