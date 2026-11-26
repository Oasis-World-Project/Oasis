// 参数面板：成品参数怎么写进修改意见、哪些能近似预览、从面板到发出修改。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { fieldsFor, formatValue, mediaLook, toParameters } from '../src/canvas/parameters.ts';
import { installFakeApi, json } from './fake-api.ts';

describe('成品参数', () => {
  it('每类成果有自己的参数；文档没有', () => {
    expect(fieldsFor('video').map((f) => f.label)).toContain('字幕字号');
    expect(fieldsFor('audio').map((f) => f.label)).toContain('语速');
    expect(fieldsFor('model').map((f) => f.label)).toContain('主体材质');
    expect(fieldsFor('image').map((f) => f.label)).toEqual(['输出尺寸', '导出格式']);
    expect(fieldsFor('document')).toEqual([]);
  });

  it('只把改过的写进修改意见，值带单位和符号', () => {
    const video = fieldsFor('video');
    expect(
      toParameters('短片.mp4', video, { subtitleSize: '大', musicVolume: -6, brightness: 10 }),
    ).toEqual([
      { file: '短片.mp4', name: '字幕字号', value: '大' },
      { file: '短片.mp4', name: '背景音乐音量', value: '-6 dB' },
      { file: '短片.mp4', name: '亮度', value: '+10%' },
    ]);
    const image = fieldsFor('image');
    expect(toParameters('图.png', image, { size: [1920, 0] })).toEqual([]);
    expect(toParameters('图.png', image, { size: [1920, 1080] })).toEqual([
      { file: '图.png', name: '输出尺寸', value: '1920×1080 像素' },
    ]);
    expect(formatValue(fieldsFor('audio')[0]!, 1.1)).toBe('1.1 倍');
  });

  it('近似预览：亮度和色温用滤镜，音量只能调低，语速用倍速', () => {
    expect(mediaLook({})).toEqual({});
    expect(mediaLook({ brightness: 20, tone: '暖' }).filter).toBe(
      'brightness(1.2) sepia(0.25) saturate(1.1)',
    );
    expect(mediaLook({ volume: 6 }).volume).toBe(1);
    expect(mediaLook({ volume: -6 }).volume).toBeCloseTo(0.501, 2);
    expect(mediaLook({ rate: 0.9 }).rate).toBe(0.9);
  });
});

const CONV = '00000000-0000-4000-8000-0000000000c1';
const video: ArtifactBody = {
  id: '00000000-0000-4000-8000-000000000911',
  name: '宣传短片.mp4',
  path: '宣传短片.mp4',
  size: 100,
  contentType: 'video/mp4',
  category: 'media',
  conversationId: CONV,
  sessionId: '00000000-0000-4000-8000-0000000000f1',
  runId: '00000000-0000-4000-8000-0000000000a1',
  task: '民宿短片',
  models: [],
  syncPath: '民宿短片/宣传短片.mp4',
  annotations: [],
  approvedAt: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('「编辑」里直接调参数', () => {
  it('改字幕字号和亮度：画面套上滤镜，「让 AI 改」带着参数发出', async () => {
    const sent: unknown[] = [];
    installFakeApi({
      signedIn: true,
      dms: [
        {
          id: CONV,
          kind: 'dm',
          title: 'DeepSeek',
          modelKey: 'deepseek',
          createdAt: video.createdAt,
          lastMessageAt: null,
          turn: null,
        },
      ],
      extra: (method, path, body) => {
        if (method === 'GET' && path === `/canvas/v1/artifacts/${video.id}`)
          return json(200, video);
        if (method === 'GET' && path.startsWith('/canvas/v1/artifacts'))
          return json(200, { artifacts: [video] });
        const messages = `/conversation/v1/conversations/${CONV}/messages`;
        if (method === 'POST' && path === messages) {
          sent.push(body);
          return json(201, { messages: [], turn: null });
        }
        if (method === 'GET' && path === messages) return json(200, { messages: [], turn: null });
        return undefined;
      },
    });
    const { App, router } = createApp({
      history: createMemoryHistory({ initialEntries: [`/canvas/artifacts/${video.id}`] }),
    });
    await act(() => router.load());
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const panel = within(screen.getByRole('complementary', { name: '要改的地方' })).getByRole(
      'region',
      { name: '直接调' },
    );
    // 什么都没改、也没写要求：不能发
    const send = screen.getByRole('button', { name: '让 AI 改' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      within(within(panel).getByRole('radiogroup', { name: '字幕字号' })).getByRole('radio', {
        name: '大',
      }),
    );
    fireEvent.change(within(panel).getByRole('slider', { name: '亮度' }), {
      target: { value: '10' },
    });
    expect(document.querySelector('video')?.style.filter).toBe('brightness(1.1)');
    fireEvent.click(screen.getByRole('button', { name: '让 AI 改 · 2 处' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      content:
        '改一下「宣传短片.mp4」\n参数：\n「宣传短片.mp4」字幕字号：大\n「宣传短片.mp4」亮度：+10%',
      attachments: [],
      artifacts: [video.id],
    });
  });
});
