import { z } from 'zod';
import { onlineManager } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { api } from '../src/api/client.ts';
import { installFakeApi, json } from './fake-api.ts';

const ID = '00000000-0000-4000-8000-0000000000c1';
const PATH = `/conversation/v1/conversations/${ID}/messages`;
const message = {
  id: ID,
  role: 'user',
  kind: 'text',
  data: {},
  content: '已有消息',
  status: 'complete',
  error: null,
  createdAt: '2026-11-04T00:00:00Z',
};
const clients: ReturnType<typeof createApp>['queryClient'][] = [];
async function open() {
  const app = createApp({ history: createMemoryHistory({ initialEntries: [`/dms/${ID}`] }) });
  clients.push(app.queryClient);
  await act(() => app.router.load());
  render(<app.App />);
  return app;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('中断后的消息恢复', () => {
  it('离线冷启动有明确等待页，联网后读取原会话', async () => {
    const network = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const fake = installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH ? json(200, { messages: [message], turn: null }) : undefined,
    });
    const app = createApp({ history: createMemoryHistory({ initialEntries: [`/dms/${ID}`] }) });
    clients.push(app.queryClient);
    act(() => {
      void app.router.load();
    });
    render(<app.App />);
    await screen.findByRole('heading', { name: '当前离线' });
    expect(fake.requests).toHaveLength(0);
    network.mockReturnValue(true);
    await act(async () => {
      onlineManager.setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await screen.findByText('已有消息');
  });

  it('重连后会话已过期则要求登录，不把网络故障误作登录成功', async () => {
    let available = false;
    const fake = installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === '/identity/v1/me' && !available ? json(503, {}) : undefined,
    });
    await open();
    await screen.findByRole('heading', { name: '暂时无法打开 Oasis' });
    available = true;
    fake.signedIn = false;
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await screen.findByRole('heading', { name: '登录 Oasis' });
    expect(fake.requests).not.toContain(`GET ${PATH}`);
  });

  it('首次打开时服务不可用，仍能自动恢复原地址，并且没有绕过登录核对', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let available = false;
    const fake = installFakeApi({
      signedIn: true,
      extra: (_method, path) => {
        if (path === '/identity/v1/me' && !available)
          return json(503, { error: { code: 'unavailable', message: '服务未启动' } });
        if (path === PATH) return json(200, { messages: [message], turn: null });
        return undefined;
      },
    });
    const app = await open();
    await screen.findByRole('heading', { name: '暂时无法打开 Oasis' });
    expect(fake.requests).not.toContain(`GET ${PATH}`);
    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    await screen.findByText('已有消息');
    expect(app.router.state.location.pathname).toBe(`/dms/${ID}`);
  });

  it('加载失败不会变成空会话，服务恢复后自动读取，不重放发送请求', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let available = false;
    const fake = installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH
          ? available
            ? json(200, { messages: [message], turn: null })
            : Promise.reject(new TypeError('offline'))
          : undefined,
    });
    await open();
    await screen.findByRole('button', { name: '重试加载消息' });
    expect(screen.queryByText(/打个招呼/)).toBeNull();
    expect(screen.queryByText('正在加载消息…')).toBeNull();
    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(await screen.findByText('已有消息')).toBeTruthy();
    expect(fake.requests.every((request) => request.startsWith('GET '))).toBe(true);
  });

  it('断网保留消息和草稿，联网后同步服务器记录', async () => {
    let content = '已有消息';
    installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH ? json(200, { messages: [{ ...message, content }], turn: null }) : undefined,
    });
    await open();
    await screen.findByText('已有消息');
    const input = screen.getByPlaceholderText('发消息…');
    fireEvent.change(input, { target: { value: '尚未发送的草稿' } });
    await act(async () => {
      onlineManager.setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/当前离线/)).toBeTruthy();
    expect(screen.getByText('已有消息')).toBeTruthy();
    content = '中断期间已写入的消息';
    await act(async () => {
      onlineManager.setOnline(true);
    });
    await screen.findByText(content);
    expect(input).toHaveProperty('value', '尚未发送的草稿');
  });

  it('普通 GET 请求包含正文读取截止，取消保留原有取消语义', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          ),
      ),
    );
    await expect(api('/hung', z.unknown(), { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'request_timeout',
    });
    const controller = new AbortController();
    const pending = api('/cancelled', z.unknown(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('HTTP 头已返回而 JSON 正文悬挂时仍超时，正文断流可重连', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener(
                  'abort',
                  () => controller.error(init.signal?.reason),
                  { once: true },
                );
              },
            }),
          ),
      ),
    );
    await expect(api('/hung-body', z.unknown(), { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'request_timeout',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('terminated'));
              },
            }),
          ),
      ),
    );
    await expect(api('/broken-body', z.unknown())).rejects.toMatchObject({ code: 'network_error' });
  });

  it('已有消息后台读取失败仍可见，点击重试恢复', async () => {
    let broken = false;
    installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH
          ? broken
            ? json(503, { error: { code: 'unavailable', message: '暂时不可用' } })
            : json(200, { messages: [message], turn: null })
          : undefined,
    });
    const app = await open();
    await screen.findByText('已有消息');
    broken = true;
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['messages', ID] });
    });
    await screen.findByRole('button', { name: '重试加载消息' });
    expect(screen.getByText('已有消息')).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重试加载消息' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试加载消息' })).toBeNull());
  });
});

describe('停下、出错后的「继续」', () => {
  it.each(['stopped', 'failed'] as const)(
    '%s：刷新后 AI 消息下面仍有「继续」，点了发一句「继续」开下一轮；进行中能停下',
    async (mode) => {
      const RUN = '00000000-0000-4000-8000-0000000000b1';
      const NEXT = '00000000-0000-4000-8000-0000000000b2';
      const reply = {
        ...message,
        id: '00000000-0000-4000-8000-0000000000c2',
        role: 'assistant',
        content: '已经写了一半',
        status: mode === 'failed' ? 'failed' : 'complete',
        error: mode === 'failed' ? '这一轮出错了：上游 500。说「继续」可以接着做' : null,
        data: {
          runId: RUN,
          parts: [{ type: 'text', text: '已经写了一半' }],
          ...(mode === 'stopped' ? { stopped: true } : {}),
        },
      };
      let messages: unknown[] = [message, reply];
      let turn: { runId: string; startedAt: string } | null = null;
      const fake = installFakeApi({
        signedIn: true,
        extra: (method, path) => {
          if (method === 'GET' && path === PATH) return json(200, { messages, turn });
          if (method === 'POST' && path === PATH) {
            turn = { runId: NEXT, startedAt: '2026-11-04T00:01:00Z' };
            const user = {
              ...message,
              id: '00000000-0000-4000-8000-0000000000c3',
              content: '继续',
              data: { runId: NEXT },
            };
            const ai = {
              ...message,
              id: '00000000-0000-4000-8000-0000000000c4',
              role: 'assistant',
              content: '',
              status: 'streaming',
              data: { runId: NEXT, parts: [] },
            };
            messages = [...messages, user, ai];
            return json(201, { messages: [user, ai], turn });
          }
          if (method === 'POST' && path === `/conversation/v1/conversations/${ID}/stop`)
            return new Response(null, { status: 204 });
          return undefined;
        },
      });
      await open();
      expect(await screen.findByText('已经写了一半')).toBeTruthy();
      expect(
        await screen.findByText(mode === 'failed' ? /说「继续」可以接着做/ : '已停下'),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '继续' }));
      await waitFor(() =>
        expect(fake.bodies).toContainEqual({
          path: PATH,
          body: { content: '继续', attachments: [] },
        }),
      );
      // 这一轮在做：「继续」不见了，发的话先排着，也可以停下
      const stop = await screen.findByRole('button', { name: '停下这一轮' });
      expect(screen.queryByRole('button', { name: '继续' })).toBeNull();
      expect(screen.getByPlaceholderText('AI 正在做，发的话先排着，做完接着做…')).toBeTruthy();
      fireEvent.click(stop);
      await waitFor(() =>
        expect(fake.requests).toContain(`POST /conversation/v1/conversations/${ID}/stop`),
      );
    },
  );
});
