// 一轮的进度页：主 AI 卡（状态、正在做的一步、用时、花费、待办、停下）、长任务卡（已等多久、通常要多久、
// 做出的东西）、经过（说的话、步骤、插话）、这一轮做出的文件（点开预览）、交出的成品。
import type { MessageBody } from '@oasis/contracts/conversation';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json } from './fake-api.ts';

const CONV = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const PATH = `/conversation/v1/conversations/${CONV}/messages`;
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

let seq = 0;
const message = (kind: MessageBody['kind'], data: object, role = 'assistant', content = '') =>
  ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    role,
    content,
    status: 'complete',
    error: null,
    createdAt: ago(300),
    kind,
    data,
  }) as MessageBody;
const step = (id: string, label: string, extra: object) => ({
  type: 'step',
  id,
  tool: 'bash',
  label,
  status: 'done',
  ...extra,
});

/** 开业视频做到一半：两张关键帧做好了，两段视频交上去了，正在一起等；中间用户插了一句 */
const messages = [
  message('text', { runId: RUN }, 'user', '做个开业视频'),
  message('text', {
    runId: RUN,
    parts: [
      { type: 'text', text: '先出两张**关键帧**' },
      step('i', '生成图片：门店外景', {
        oasisTool: 'image.generate',
        expectSeconds: 30,
        startedAt: ago(200),
        finishedAt: ago(170),
        files: ['out/关键帧/帧-1.png', 'out/关键帧/帧-2.png'],
      }),
      step('w', '写文件 out/分镜.md', {
        tool: 'write',
        files: ['out/分镜.md'],
        finishedAt: ago(160),
      }),
    ],
  }),
  message('text', { runId: RUN, interjection: true }, 'user', '改成竖屏'),
  {
    ...message('text', {
      runId: RUN,
      parts: [
        step('v', '生成视频：开业', {
          status: 'running',
          oasisTool: 'video.generate',
          expectSeconds: 180,
          startedAt: ago(60),
        }),
      ],
      todos: [
        { text: '关键帧', status: 'done' },
        { text: '两段视频', status: 'doing' },
      ],
    }),
    status: 'streaming',
  } as MessageBody,
  message('task', {
    runId: RUN,
    status: 'running',
    startedAt: ago(300),
    finishedAt: null,
    spentMicro: 120_000,
    files: [],
  }),
];

function fakeRun(list = messages, live = true) {
  return installFakeApi({
    signedIn: true,
    dms: [
      {
        id: CONV,
        kind: 'dm',
        title: 'Claude',
        modelKey: 'claude',
        createdAt: ago(900),
        lastMessageAt: null,
        turn: null,
      },
    ],
    extra: (method, path) => {
      if (method === 'GET' && path === PATH)
        return json(200, {
          messages: list,
          turn: live ? { runId: RUN, startedAt: ago(300) } : null,
        });
      if (method === 'POST' && path === `/conversation/v1/conversations/${CONV}/stop`)
        return new Response(null, { status: 204 });
      return undefined;
    },
  });
}

async function openProgress(search = `?conversation=${CONV}`) {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/canvas/runs/${RUN}${search}`] }),
  });
  await act(() => router.load());
  render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('一轮的进度页', () => {
  it('主 AI 卡：进行中、正在做的一步、用时、花费、待办；能停下', async () => {
    const api = fakeRun();
    await openProgress();
    const lead = await screen.findByRole('region', { name: '主 AI' });
    expect(within(lead).getByText('进行中')).toBeTruthy();
    expect(lead.textContent).toContain('生成视频：开业');
    expect(lead.textContent).toMatch(/用时 5 分 \d+ 秒/);
    expect(lead.textContent).toContain('$0.1200');
    expect(within(lead).getByText('待办 1/2')).toBeTruthy();
    fireEvent.click(within(lead).getByRole('button', { name: '停下' }));
    await waitFor(() =>
      expect(api.requests).toContain(`POST /conversation/v1/conversations/${CONV}/stop`),
    );
  });

  it('长任务一张张卡：做完的写用了多久、放出做出的图；在做的写已等多久、通常要多久', async () => {
    fakeRun();
    await openProgress();
    const tasks = await screen.findByRole('region', { name: '长任务' });
    const images = within(tasks).getByRole('article', { name: '生成图片：门店外景' });
    expect(images.textContent).toContain('用了 30 秒 · 通常约 30 秒');
    const thumb = within(images).getAllByRole('button', { name: /预览 out\/关键帧\/帧-/ })[0]!;
    expect(thumb.querySelector('img')?.getAttribute('src')).toMatch(
      new RegExp(
        `^/api/conversation/v1/conversations/${CONV}/runs/${RUN}/files/out/%E5%85%B3%E9%94%AE%E5%B8%A7/%E5%B8%A7-1\\.png\\?v=`,
      ),
    );
    const video = within(tasks).getByRole('article', { name: '生成视频：开业' });
    expect(video.textContent).toMatch(/已等 1 分 \d+ 秒 · 通常约 3 分 0 秒/);
    expect(within(video).getByRole('progressbar', { name: '大概进度' })).toBeTruthy();
  });

  it('经过：说的话、折叠的步骤、插话按顺序；这一轮做出的文件点开预览', async () => {
    fakeRun();
    await openProgress();
    const story = await screen.findByRole('region', { name: '经过' });
    expect(within(story).getByText('关键帧').tagName).toBe('STRONG');
    expect(within(story).getByText('插话')).toBeTruthy();
    expect(within(story).getByText('改成竖屏')).toBeTruthy();
    const files = screen.getByRole('region', { name: '做出的文件' });
    // 最新的在前；还在做的那一步没有文件
    expect(
      within(files)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['预览 out/分镜.md', '预览 out/关键帧/帧-2.png', '预览 out/关键帧/帧-1.png']);
    fireEvent.click(within(files).getByRole('button', { name: '预览 out/关键帧/帧-2.png' }));
    const dialog = await screen.findByLabelText('预览 帧-2.png');
    expect(within(dialog).getByRole('img', { hidden: true }).getAttribute('src')).toContain(
      `/runs/${RUN}/files/out/`,
    );
  });

  it('几段视频先交后一起等：按任务号一段一张卡，等到前「在做」，等到后放出各自的视频；等的那一步不另成卡', async () => {
    const A = '00000000-0000-4000-8000-00000000a001';
    const B = '00000000-0000-4000-8000-00000000b002';
    const submit = (id: string, label: string, job: string) =>
      step(id, label, {
        oasisTool: 'video.generate',
        expectSeconds: 150,
        startedAt: ago(100),
        finishedAt: ago(96),
        jobs: [{ id: job, state: 'submitted' }],
      });
    const segment = (parts: object[]) => message('text', { runId: RUN, parts });
    const waiting = step('w', '等长任务的结果', {
      status: 'running',
      oasisTool: 'wait',
      startedAt: ago(90),
    });
    fakeRun([
      message('text', { runId: RUN }, 'user', '做两段开业视频'),
      segment([submit('a', '生成视频：门店外景', A), submit('b', '生成视频：剪彩', B), waiting]),
    ]);
    await openProgress();
    const tasks = await screen.findByRole('region', { name: '长任务' });
    expect(
      within(tasks)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['生成视频：门店外景', '生成视频：剪彩']);
    const outside = within(tasks).getByRole('article', { name: '生成视频：门店外景' });
    expect(outside.textContent).toMatch(/已等 1 分 \d+ 秒 · 通常约 2 分 30 秒/);
    vi.unstubAllGlobals();
    cleanup();

    // 等到了：一段做好、一段没做出来；一轮结束后只剩 out/ 里的文件
    const done = {
      ...waiting,
      status: 'failed',
      detail: '有一段没做出来',
      finishedAt: ago(10),
      files: ['out/外景.mp4', 'work/草稿.png'],
      jobs: [
        { id: A, state: 'done', files: ['out/外景.mp4'] },
        { id: B, state: 'failed' },
      ],
    };
    fakeRun(
      [
        message('text', { runId: RUN }, 'user', '做两段开业视频'),
        segment([submit('a', '生成视频：门店外景', A), submit('b', '生成视频：剪彩', B), done]),
      ],
      false,
    );
    await openProgress();
    const after = await screen.findByRole('region', { name: '长任务' });
    const shot = within(after).getByRole('article', { name: '生成视频：门店外景' });
    expect(shot.textContent).toMatch(/用了 1 分 30 秒/);
    expect(within(shot).getByLabelText('外景.mp4').getAttribute('src')).toContain('/files/out/');
    expect(within(after).getByRole('article', { name: '生成视频：剪彩' }).textContent).toContain(
      '有一段没做出来',
    );
    const files = screen.getByRole('region', { name: '做出的文件' });
    expect(files.textContent).toContain('另有 1 个中间文件只在这一轮进行中能看');
    expect(within(files).getAllByRole('button')).toHaveLength(1);
  });

  it('不知道是哪个私聊：说清楚从哪里打开', async () => {
    fakeRun();
    await openProgress('');
    expect(await screen.findByText(/请从私聊里任务卡上的「看进度」打开/)).toBeTruthy();
  });
});
