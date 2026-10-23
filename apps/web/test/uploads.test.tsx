// 随消息发文件（5.5a）：选文件就上传，传完才能发送，发出的消息下面显示附件。
import type { MessageBody } from '@oasis/contracts/conversation';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi } from './fake-api.ts';

const NOW = '2026-10-23T08:00:00.000Z';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const UPLOAD = '00000000-0000-4000-8000-0000000000d1';
const DM = {
  id: CONV,
  kind: 'dm',
  title: 'Claude',
  modelKey: 'claude',
  createdAt: NOW,
  lastMessageAt: NOW,
};

/** 假 XHR：记下上传的请求，按 respond 的设定应答；hold 时先不应答 */
class FakeXhr {
  static sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  static hold = false;
  static pending: FakeXhr[] = [];
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  responseText = '';
  private url = '';
  private headers: Record<string, string> = {};
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: File) {
    FakeXhr.sent.push({ url: this.url, headers: this.headers, body });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    if (FakeXhr.hold) FakeXhr.pending.push(this);
    else this.finish();
  }
  finish() {
    this.status = 201;
    this.responseText = JSON.stringify({
      id: UPLOAD,
      name: '民宿照片.jpg',
      size: 2048,
      contentType: 'image/jpeg',
      createdAt: NOW,
    });
    queueMicrotask(() => this.onload?.());
  }
  abort() {
    this.onabort?.();
  }
}

function chat() {
  const state = { messages: [] as MessageBody[] };
  const api = installFakeApi({
    signedIn: true,
    dms: [DM],
    extra: (method, path) => {
      if (path !== `/conversation/v1/conversations/${CONV}/messages`) return undefined;
      if (method === 'GET') return new Response(JSON.stringify({ messages: state.messages }));
      const userMessage = {
        id: '00000000-0000-4000-8000-0000000000e1',
        role: 'user',
        content: '用这张照片',
        status: 'complete',
        error: null,
        createdAt: NOW,
        kind: 'text',
        data: {
          attachments: [
            { id: UPLOAD, name: '民宿照片.jpg', size: 2048, contentType: 'image/jpeg' },
          ],
        },
      } as MessageBody;
      state.messages = [userMessage];
      return new Response(`data: ${JSON.stringify({ type: 'accepted', userMessage })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  return api;
}

async function openChat() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: [`/dms/${CONV}`] }),
  });
  await act(() => router.load());
  render(<App />);
  await screen.findByRole('heading', { name: 'Claude' });
}

const photo = () => new File(['jpeg'], '民宿照片.jpg', { type: 'image/jpeg' });

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.sent = [];
  FakeXhr.hold = false;
  FakeXhr.pending = [];
});

describe('上传素材', () => {
  it('选了文件就上传，传完才能发；发消息带上文件 id，发出的消息下面能下载', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.hold = true;
    const api = chat();
    await openChat();
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '用这张照片' } });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [photo()] } });

    const pending = await screen.findByRole('list', { name: '要发送的文件' });
    expect(within(pending).getByText('上传中 50%')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', true);
    expect(FakeXhr.sent[0]).toMatchObject({
      url: `/api/canvas/v1/uploads?name=${encodeURIComponent('民宿照片.jpg')}`,
      headers: { 'content-type': 'application/octet-stream' },
    });

    act(() => FakeXhr.pending[0]!.finish());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送' })).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    const sent = await screen.findByRole('list', { name: '附件' });
    expect(api.bodies.find((b) => b.path.endsWith('/messages'))?.body).toEqual({
      content: '用这张照片',
      asTask: false,
      attachments: [UPLOAD],
    });
    expect(within(sent).getByRole('link', { name: '下载 民宿照片.jpg' }).getAttribute('href')).toBe(
      `/api/canvas/v1/uploads/${UPLOAD}?download=1`,
    );
    expect(screen.queryByRole('list', { name: '要发送的文件' })).toBeNull();
  });

  it('超过 100 MB 的文件不上传，并说明原因；可以移除文件', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    chat();
    await openChat();
    const big = photo();
    Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files: [big, photo()] } });
    expect(await screen.findByText(/超过 100 MB，没有添加/)).toBeTruthy();
    expect(FakeXhr.sent).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: '移除 民宿照片.jpg' }));
    expect(screen.queryByRole('list', { name: '要发送的文件' })).toBeNull();
  });
});
