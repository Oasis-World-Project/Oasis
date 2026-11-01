// 数字人成果的实时对话页（ADR 0013）：事件 → 对话记录和等待时间；开始、打字提问、结束都走对的接口。
import { AvatarSpec } from '@oasis/contracts/avatar';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { asked, initialRoom, reduceEvent } from '../src/canvas/avatar-room.ts';
import { installFakeApi, json } from './fake-api.ts';

/** 假的 LiveKit：记下监听器和发出的数据；测试里手动推事件 */
const lk = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const published: string[] = [];
  return {
    handlers,
    published,
    connected: [] as string[],
    disconnected: { count: 0 },
    emit: (event: object) =>
      handlers.get('dataReceived')?.(
        new TextEncoder().encode(JSON.stringify(event)),
        undefined,
        undefined,
        'agent-response',
      ),
  };
});
vi.mock('livekit-client', () => ({
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    DataReceived: 'dataReceived',
    Disconnected: 'disconnected',
  },
  Track: { Kind: { Video: 'video', Audio: 'audio' } },
  Room: class {
    on(event: string, handler: (...args: unknown[]) => void) {
      lk.handlers.set(event, handler);
      return this;
    }
    async connect(url: string) {
      lk.connected.push(url);
    }
    async disconnect() {
      lk.disconnected.count += 1;
    }
    localParticipant = {
      // 没有麦克风权限：页面要提示可以打字
      setMicrophoneEnabled: async () => {
        throw new Error('NotAllowedError');
      },
      publishData: async (data: Uint8Array) => {
        lk.published.push(new TextDecoder().decode(data));
      },
    };
  },
}));

describe('数字人事件 → 对话记录', () => {
  it('逐字拼出数字人的回答；打字的问题不记两次；记下从提问到开口的等待', () => {
    let s = reduceEvent(
      initialRoom,
      { event_type: 'avatar.transcription', text: '你好，我是 AI 前台。', session_id: 'p1' },
      0,
    );
    expect(s.providerSessionId).toBe('p1');
    s = asked(s, '早餐几点？', 1000);
    s = reduceEvent(s, { event_type: 'user.transcription', text: '早餐几点？' }, 1100);
    s = reduceEvent(s, { event_type: 'avatar.transcription.chunk', text: '七点' }, 3000);
    s = reduceEvent(s, { event_type: 'avatar.speak_started' }, 3500);
    s = reduceEvent(s, { event_type: 'avatar.transcription.chunk', text: '开始。' }, 3600);
    expect(s.lines.at(-1)).toMatchObject({ who: 'avatar', text: '七点开始。', pending: true });
    s = reduceEvent(s, { event_type: 'avatar.speak_ended' }, 5000);
    expect(s.lines.map((l) => `${l.who}:${l.text}`)).toEqual([
      'avatar:你好，我是 AI 前台。',
      'user:早餐几点？',
      'avatar:七点开始。',
    ]);
    expect(s.waits).toEqual([2500]);
    s = reduceEvent(s, { event_type: 'session.stopped', end_reason: 'IDLE_TIMEOUT' }, 9000);
    expect(s.ended).toBe('IDLE_TIMEOUT');
  });

  it('数字人没说完就被打断：那句按已收到的字收尾，不会一直停在「正在说」', () => {
    let s = reduceEvent(
      initialRoom,
      { event_type: 'avatar.transcription.chunk', text: '您好，我是' },
      0,
    );
    s = asked(s, '早餐几点？', 100);
    expect(s.lines.map((l) => [l.text, l.pending])).toEqual([
      ['（被打断）', false],
      ['早餐几点？', false],
    ]);
    // 回推的问题晚到（数字人已经开始回答）：也不再记一次
    s = reduceEvent(s, { event_type: 'avatar.transcription.chunk', text: '七点' }, 200);
    s = reduceEvent(s, { event_type: 'user.transcription', text: '早餐几点？' }, 300);
    expect(s.lines.filter((l) => l.who === 'user')).toHaveLength(1);
    expect(s.lines.at(-1)).toMatchObject({ who: 'avatar', pending: true });
  });
});

const ARTIFACT = '00000000-0000-4000-8000-000000000a01';
const SESSION = '00000000-0000-4000-8000-000000000b01';
const spec = AvatarSpec.parse({
  name: '民宿前台',
  avatarId: '9c59a215-4c9f-478f-9d95-edca74c7b0d0',
  prompt: '你是山间民宿的前台',
  openingText: '你好，我是 AI 前台',
  knowledge: [{ title: '早餐', content: '七点到九点半' }],
  handoff: { when: '要退款', message: '我帮您转给经理' },
});
const artifact: ArtifactBody = {
  id: ARTIFACT,
  name: '民宿前台.oasis-avatar.json',
  path: '民宿前台.oasis-avatar.json',
  size: 300,
  contentType: 'application/json',
  category: 'app',
  avatar: spec,
  deliverable: '数字人',
  taskId: '00000000-0000-4000-8000-0000000000f1',
  nodeId: '00000000-0000-4000-8000-0000000000a1',
  taskTitle: '民宿前台数字人',
  conversationId: null,
  models: [],
  syncPath: '民宿前台数字人/民宿前台.oasis-avatar.json',
  annotations: [],
  approvedAt: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('数字人对话页', () => {
  it('开始 → 连房间；没有麦克风时可以打字提问；后台记录显示引用；结束会通知后台', async () => {
    const calls: string[] = [];
    installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method === 'GET' && path === `/canvas/v1/artifacts/${ARTIFACT}`)
          return json(200, artifact);
        if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
          return json(200, { artifacts: [artifact] });
        if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
        if (path.includes('avatar-sessions')) calls.push(`${method} ${path}`);
        if (method === 'POST' && path === `/canvas/v1/artifacts/${ARTIFACT}/avatar-sessions`)
          return json(201, {
            sessionId: SESSION,
            livekitUrl: 'wss://room',
            livekitToken: 'lk',
            sandbox: true,
            maxSeconds: 300,
            pricePerMinuteMicro: 0,
            startedAt: new Date().toISOString(),
          });
        if (method === 'GET' && path === `/canvas/v1/avatar-sessions/${SESSION}`)
          return json(200, {
            sessionId: SESSION,
            status: 'live',
            sandbox: true,
            maxSeconds: 300,
            startedAt: new Date().toISOString(),
            endedAt: null,
            endReason: null,
            turns: [
              {
                at: new Date().toISOString(),
                question: '早餐几点？',
                answer: '七点到九点半',
                sources: ['早餐'],
                handoff: false,
                firstTokenMs: 820,
                totalMs: 1500,
              },
            ],
            pricePerMinuteMicro: 0,
            chargedMicro: null,
          });
        if (method === 'POST' && path === `/canvas/v1/avatar-sessions/${SESSION}/stop`)
          return new Response(null, { status: 204 });
        return undefined;
      },
    });
    const { App, router } = createApp({
      history: createMemoryHistory({ initialEntries: [`/canvas/artifacts/${ARTIFACT}`] }),
    });
    await act(() => router.load());
    render(<App />);

    expect(await screen.findByText('开场白：你好，我是 AI 前台')).toBeTruthy();
    expect(screen.getByText(/1 条知识要点 · 转人工：要退款/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始对话' }));
    expect(await screen.findByText('没有麦克风权限')).toBeTruthy();
    expect(lk.connected).toEqual(['wss://room']);
    expect(screen.getByText(/开发环境沙箱：免费/)).toBeTruthy();

    act(() =>
      lk.emit({
        event_type: 'avatar.transcription',
        text: '你好，我是 AI 前台',
        session_id: 'prov-1',
      }),
    );
    fireEvent.change(screen.getByLabelText('打字提问'), { target: { value: '早餐几点？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(JSON.parse(lk.published.at(-1)!)).toMatchObject({
      event_type: 'avatar.speak_response',
      text: '早餐几点？',
      session_id: 'prov-1',
    });
    const transcript = screen.getByRole('region', { name: '对话记录' });
    expect(transcript.textContent).toContain('早餐几点？');
    expect(await screen.findByText(/查了：早餐 · 模型 0\.8 秒出第一个字/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '结束对话' }));
    await waitFor(() => expect(calls).toContain(`POST /canvas/v1/avatar-sessions/${SESSION}/stop`));
    expect(lk.disconnected.count).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: '再对话一次' })).toBeTruthy();
  });

  it('参数面板：数字人的语气、时长等改过的项变成修改意见', async () => {
    installFakeApi({
      signedIn: true,
      extra: (method, path) => {
        if (method === 'GET' && path === `/canvas/v1/artifacts/${ARTIFACT}`)
          return json(200, artifact);
        if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
          return json(200, { artifacts: [artifact] });
        if (method === 'GET' && path === '/task/v1/tasks') return json(200, { tasks: [] });
        return undefined;
      },
    });
    const { App, router } = createApp({
      history: createMemoryHistory({ initialEntries: [`/canvas/artifacts/${ARTIFACT}`] }),
    });
    await act(() => router.load());
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '参数' }));
    const panel = screen.getByRole('complementary', { name: '参数' });
    fireEvent.click(
      within(within(panel).getByRole('radiogroup', { name: '语气' })).getByRole('radio', {
        name: '更正式',
      }),
    );
    fireEvent.click(
      within(within(panel).getByRole('radiogroup', { name: '单次最长时长' })).getByRole('radio', {
        name: '10 分钟',
      }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: '按这些参数改一版（2 项）' }));
    const dialog = await screen.findByLabelText('修改「民宿前台数字人」');
    const list = within(dialog).getByRole('region', { name: '参数修改', hidden: true });
    expect(list.textContent).toContain('语气：更正式');
    expect(list.textContent).toContain('单次最长时长：10 分钟');
  });
});
