// 一轮的进度页：顶上任务名和主 AI 卡（状态、正在做的一步、用时、花费、待办、停下）；成果按类型分框
// （做好的点开预览，还在做的长任务写已等多久、通常要多久）；过程按 AI 说的话分段（折叠的步骤），不放用户的话。
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
const segment = (parts: object[]) => message('text', { runId: RUN, parts });
const card = (extra: object) =>
  message('task', {
    runId: RUN,
    title: '开业视频',
    status: 'running',
    startedAt: ago(300),
    finishedAt: null,
    spentMicro: 120_000,
    files: [],
    ...extra,
  });

/** 两个先交上去没等的长任务（--wait false） */
const A = '00000000-0000-4000-8000-00000000a001';
const B = '00000000-0000-4000-8000-00000000b002';
const submit = (id: string, label: string, job: string, oasisTool = 'video.generate') =>
  step(id, label, {
    oasisTool,
    expectSeconds: 150,
    startedAt: ago(100),
    finishedAt: ago(96),
    jobs: [{ id: job, state: 'submitted' }],
  });

/** 开业视频做到一半：两张关键帧、分镜做好了，正在生成视频；中间用户插了一句 */
const messages = [
  message('text', { runId: RUN }, 'user', '做个开业视频'),
  segment([
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
  ]),
  message('text', { runId: RUN, interjection: true }, 'user', '改成竖屏'),
  {
    ...message('text', {
      runId: RUN,
      parts: [
        { type: 'text', text: '好，换成竖屏接着做视频' },
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
  card({}),
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
  it('顶上是任务名；主 AI 卡：进行中、正在做的一步、用时、花费、待办；能停下', async () => {
    const api = fakeRun();
    await openProgress();
    expect(await screen.findByRole('heading', { level: 1, name: '开业视频' })).toBeTruthy();
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

  it('成果按类型分框：图片（点开预览）、在做的视频（已等多久、通常要多久、大概进度）、文档', async () => {
    fakeRun();
    await openProgress();
    const outputs = await screen.findByRole('region', { name: '成果' });
    const images = within(outputs).getByRole('region', { name: '图片' });
    const frame = within(images).getByRole('button', { name: '预览 关键帧/帧-1.png' });
    expect(frame.querySelector('img')?.getAttribute('src')).toMatch(
      new RegExp(
        `^/api/conversation/v1/conversations/${CONV}/runs/${RUN}/files/out/%E5%85%B3%E9%94%AE%E5%B8%A7/%E5%B8%A7-1\\.png\\?v=`,
      ),
    );
    fireEvent.click(within(images).getByRole('button', { name: '预览 关键帧/帧-2.png' }));
    expect(await screen.findByLabelText('预览 帧-2.png')).toBeTruthy();
    const video = within(outputs).getByRole('region', { name: '视频' });
    const shot = within(video).getByRole('article', { name: '生成视频：开业' });
    expect(shot.textContent).toMatch(/已等 1 分 \d+ 秒 · 通常约 3 分 0 秒/);
    expect(within(shot).getByRole('progressbar', { name: '大概进度' })).toBeTruthy();
    const docs = within(outputs).getByRole('region', { name: '文档' });
    expect(within(docs).getByRole('button', { name: '预览 分镜.md' })).toBeTruthy();
  });

  it('过程按 AI 说的话分段：那句话、状态、折叠的步骤，连成一条线；不放用户说的话', async () => {
    fakeRun();
    await openProgress();
    const story = await screen.findByRole('region', { name: '过程' });
    const first = within(story).getByRole('article', { name: '第 1 段' });
    expect(within(first).getByText('关键帧').tagName).toBe('STRONG');
    expect(first.textContent).toContain('做了 2 步');
    expect(first.textContent).toContain('完成');
    const second = within(story).getByRole('article', { name: '第 2 段' });
    expect(second.textContent).toContain('好，换成竖屏接着做视频');
    expect(second.textContent).toContain('进行中');
    expect(screen.queryByText('改成竖屏')).toBeNull();
    expect(screen.queryByText('做个开业视频')).toBeNull();
  });

  it('几段视频先交后一起等：按任务号一段一张卡；做完后成果从画布读，没做出来的写原因，工作目录外的不放', async () => {
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
    // 没有任务卡上的任务名：用这一轮开头那句话
    expect(await screen.findByRole('heading', { level: 1, name: '做两段开业视频' })).toBeTruthy();
    const video = await screen.findByRole('region', { name: '视频' });
    expect(
      within(video)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')),
    ).toEqual(['生成视频：门店外景', '生成视频：剪彩']);
    expect(within(video).getByRole('article', { name: '生成视频：门店外景' }).textContent).toMatch(
      /已等 1 分 \d+ 秒 · 通常约 2 分 30 秒/,
    );
    vi.unstubAllGlobals();
    cleanup();

    // 等到了：一段做好（进了画布）、一段没做出来；一轮结束后成果从画布读
    const done = {
      ...waiting,
      status: 'failed',
      detail: '有一段没做出来',
      finishedAt: ago(10),
      files: ['out/素材/外景.mp4', 'work/草稿.png'],
      jobs: [
        { id: A, state: 'done', files: ['out/素材/外景.mp4'] },
        { id: B, state: 'failed' },
      ],
    };
    const shot = {
      artifactId: '00000000-0000-4000-8000-0000000000f1',
      name: '外景.mp4',
      path: '素材/外景.mp4',
      size: 2048,
      category: 'media',
    };
    fakeRun(
      [
        message('text', { runId: RUN }, 'user', '做两段开业视频'),
        segment([submit('a', '生成视频：门店外景', A), submit('b', '生成视频：剪彩', B), done]),
        card({ status: 'failed', finishedAt: ago(5), spentMicro: 425_000, files: [shot] }),
      ],
      false,
    );
    await openProgress();
    const after = await screen.findByRole('region', { name: '视频' });
    expect(within(after).getByLabelText('外景.mp4').getAttribute('src')).toBe(
      `/api/canvas/v1/artifacts/${shot.artifactId}/content`,
    );
    expect(within(after).getByText('素材')).toBeTruthy();
    expect(within(after).getByRole('article', { name: '生成视频：剪彩' }).textContent).toContain(
      '有一段没做出来',
    );
    expect(screen.queryByRole('region', { name: '图片' })).toBeNull();
    expect(screen.getByRole('link', { name: '在画布里看' })).toBeTruthy();
  });

  it('等的命令放到后台、AI 只看了输出的末几行：按任务号写回；几秒就好的配音也在声音框里', async () => {
    fakeRun([
      message('text', { runId: RUN }, 'user', '做两段开业音乐'),
      segment([
        submit('a', '生成音乐：欢快', A, 'audio.music'),
        submit('b', '生成音乐：温暖', B, 'audio.music'),
        step('s', '配音：欢迎光临', {
          oasisTool: 'audio.speech',
          expectSeconds: 9,
          startedAt: ago(95),
          finishedAt: ago(86),
          files: ['out/旁白.mp3'],
        }),
        step('w', '等长任务的结果（放到后台）', {
          oasisTool: 'wait',
          startedAt: ago(90),
          finishedAt: ago(90),
        }),
        step('o', '看后台命令的输出', {
          tool: 'job_output',
          startedAt: ago(89),
          finishedAt: ago(20),
          files: ['out/欢快.mp3', 'out/温暖.mp3'],
          jobs: [
            { id: A, state: 'done', files: ['out/欢快.mp3'] },
            { id: B, state: 'done', files: ['out/温暖.mp3'] },
          ],
        }),
      ]),
    ]);
    await openProgress();
    const audio = await screen.findByRole('region', { name: '声音' });
    expect(within(audio).queryAllByRole('article')).toEqual([]);
    for (const name of ['旁白.mp3', '欢快.mp3', '温暖.mp3'])
      expect(within(audio).getByLabelText(name).getAttribute('src')).toContain('/files/out/');
  });

  it('不知道是哪个私聊：说清楚从哪里打开', async () => {
    fakeRun();
    await openProgress('');
    expect(await screen.findByText(/请从私聊里任务卡上的「看进度」打开/)).toBeTruthy();
  });
});
