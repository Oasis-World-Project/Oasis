import { z } from 'zod';
import { onlineManager } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { api } from '../src/api/client.ts';
import { sendMessage } from '../src/api/stream.ts';
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
      extra: (_method, path) => (path === PATH ? json(200, { messages: [message] }) : undefined),
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
        if (path === PATH) return json(200, { messages: [message] });
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
            ? json(200, { messages: [message] })
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
        path === PATH ? json(200, { messages: [{ ...message, content }] }) : undefined,
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

  it('收到 accepted 后 EOF 不能冒充完成，也不重新 POST', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(`data: ${JSON.stringify({ type: 'accepted', userMessage: message })}\n\n`),
    );
    vi.stubGlobal('fetch', fetcher);
    const seen = vi.fn();
    await expect(sendMessage(ID, { content: '测试', asTask: false }, seen)).rejects.toMatchObject({
      code: 'stream_interrupted',
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('已有消息后台读取失败仍可见，点击重试恢复', async () => {
    let broken = false;
    installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH
          ? broken
            ? json(503, { error: { code: 'unavailable', message: '暂时不可用' } })
            : json(200, { messages: [message] })
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

describe('停止和中断后的继续入口', () => {
  it.each(['stopped', 'length', 'legacy'] as const)(
    '%s 刷新后仍能从右下角继续，原消息和正文保留',
    async (mode) => {
      const replyId = '00000000-0000-4000-8000-0000000000c2';
      let reply = {
        ...message,
        id: replyId,
        role: 'assistant',
        content: '已收到的正文',
        status: mode === 'stopped' ? 'complete' : 'failed',
        error: mode === 'stopped' ? null : '回复未完成',
        data: {
          replyTo: ID,
          ...(mode === 'stopped'
            ? { stopped: true }
            : mode === 'length'
              ? { resumable: true }
              : {}),
        },
      };
      const fake = installFakeApi({
        signedIn: true,
        extra: (method, path) => {
          if (method === 'GET' && path === PATH) return json(200, { messages: [message, reply] });
          if (method === 'POST' && path === PATH + '/' + ID + '/reply') {
            reply = {
              ...reply,
              status: 'complete',
              error: null,
              content: '已收到的正文，续写完成',
              data: { replyTo: ID },
            };
            const events = [
              { type: 'accepted', userMessage: message },
              { type: 'delta', text: reply.content },
              { type: 'done', message: reply },
            ];
            return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          return undefined;
        },
      });
      await open();
      const resume = await screen.findByRole('button', { name: '继续回复' });
      expect(resume.hasAttribute('disabled')).toBe(false);
      fireEvent.change(screen.getByRole('textbox', { name: '消息' }), {
        target: { value: '新问题' },
      });
      expect(screen.queryByRole('button', { name: '继续回复' })).toBeNull();
      expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false);
      fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: '继续回复' }));
      await screen.findByText('已收到的正文，续写完成');
      expect(fake.bodies).toContainEqual({
        path: PATH + '/' + ID + '/reply',
        body: { continue: true },
      });
      expect(fake.requests.filter((r) => r.startsWith('POST '))).toHaveLength(1);
      await waitFor(() => expect(screen.queryByRole('button', { name: '继续回复' })).toBeNull());
    },
  );
});
