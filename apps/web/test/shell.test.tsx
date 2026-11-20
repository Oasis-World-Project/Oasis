import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi } from './fake-api.ts';

const ENTRIES = ['首页', 'AI 们', '广场', '画布', '群聊', '私聊', '我'];

async function renderAt(path: string) {
  const { App, router } = createApp({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<App />);
  return router;
}

/** 在登录页填邮箱、取验证码、填验证码（不点登录） */
async function enterCode() {
  fireEvent.change(await screen.findByLabelText('邮箱'), { target: { value: 'kai@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
  fireEvent.change(await screen.findByLabelText('验证码'), { target: { value: '123456' } });
}

const mainNav = () => screen.getByRole('navigation', { name: '主导航' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录', () => {
  it('没登录时打开任何页面都会去登录页，并记住原地址', async () => {
    installFakeApi({ signedIn: false });
    const router = await renderAt('/canvas');
    expect(await screen.findByRole('heading', { name: '登录 Oasis' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ redirect: '/canvas' });
  });

  it('浏览器里没登录直接打开首页：先到官网页，能下载桌面版、进网页版；桌面版里直接去登录', async () => {
    installFakeApi({ signedIn: false });
    const router = await renderAt('/');
    expect(router.state.location.pathname).toBe('/welcome');
    for (const link of screen.getAllByRole('link', { name: '下载 Windows 版' }))
      expect(link.getAttribute('href')).toBe('/download/Oasis-Setup-x64.exe');
    fireEvent.click(screen.getAllByRole('link', { name: '进入网页版' })[0]!);
    expect(await screen.findByRole('heading', { name: '登录 Oasis' })).toBeTruthy();
    cleanup();

    vi.stubGlobal('oasisDesktop', {});
    await renderAt('/');
    expect(await screen.findByRole('heading', { name: '登录 Oasis' })).toBeTruthy();
  });

  it('邮箱 → 验证码 → 登录后回到原页面', async () => {
    const api = installFakeApi({ signedIn: false });
    const router = await renderAt('/ais');
    await enterCode();
    expect(screen.getByRole('button', { name: /秒后可重新发送/ })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: 'AI 们' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/ais');
    expect(api.requests).toContain('POST /identity/v1/auth/verify');
  });

  it('用着用着会话过期（请求返回 401）：回到登录页，原地址连同查询参数都记住', async () => {
    const api = installFakeApi({ signedIn: true });
    const path = '/canvas?conversation=00000000-0000-4000-8000-0000000000c1';
    const { App, router, queryClient } = createApp({
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await act(() => router.load());
    render(<App />);
    await screen.findByRole('navigation', { name: '主导航' });
    api.signedIn = false;
    await act(() => queryClient.refetchQueries());
    expect(await screen.findByRole('heading', { name: '登录 Oasis' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ redirect: path });
  });

  it('登录页的跳转地址只接受站内路径，站外地址登录后回首页', async () => {
    installFakeApi({ signedIn: false });
    const router = await renderAt('/login?redirect=%2F%2Fevil.example.com');
    await enterCode();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '本月用量' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('侧栏', () => {
  it('7 个一级入口都在，并显示额度', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/');
    for (const name of ENTRIES) {
      expect(within(mainNav()).getByRole('link', { name })).toBeTruthy();
    }
    expect((await screen.findAllByText('$30.00')).length).toBeGreaterThan(0);
  });

  it('当前页高亮，其他入口不高亮', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/canvas');
    expect(within(mainNav()).getByRole('link', { name: '画布' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(mainNav()).getByRole('link', { name: '首页' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('收起后入口仍可用，刷新后保持收起', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(mainNav().dataset.state).toBe('closed');
    for (const name of ENTRIES) {
      expect(within(mainNav()).getByRole('link', { name })).toBeTruthy();
    }

    cleanup();
    await renderAt('/');
    expect(mainNav().dataset.state).toBe('closed');
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeTruthy();
  });
});

describe('页面', () => {
  it('AI 们：可用的模型能私聊、能进设置，没接入的显示即将接入；别的类只能看', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/ais');
    expect(await screen.findByRole('button', { name: '和 Claude 私聊' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByRole('link', { name: 'Claude 的设置' }).getAttribute('href')).toBe(
      '/ais/claude',
    );
    expect(screen.getByRole('button', { name: '和 文心 私聊' })).toHaveProperty('disabled', true);
    expect(screen.getByText('即将接入')).toBeTruthy();
    expect(screen.queryByText('Seedream 5.0 Pro')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /图像生成/ }));
    const panel = screen.getByRole('tabpanel', { name: '图像生成' });
    expect(within(panel).getByText('Seedream 5.0 Pro')).toBeTruthy();
    expect(within(panel).getByText('生图时先用它')).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('广场是沉浸式页面，不带侧栏，可以离开回首页', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/plaza');
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
    expect(screen.getByRole('link', { name: '离开广场' }).getAttribute('href')).toBe('/');
  });

  it('未知地址显示 404 页', async () => {
    installFakeApi({ signedIn: true });
    await renderAt('/no-such-page');
    expect(screen.getByRole('heading', { name: '没有这个页面' })).toBeTruthy();
  });
});
