import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createAppRouter } from '../src/router.tsx';

const ENTRIES = ['首页', 'AI 们', '广场', '画布', '群聊', '私聊', '我'];

async function renderAt(path: string) {
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  return router;
}

const mainNav = () => screen.getByRole('navigation', { name: '主导航' });

describe('侧栏', () => {
  it('7 个一级入口都在', async () => {
    await renderAt('/');
    for (const name of ENTRIES) {
      expect(within(mainNav()).getByRole('link', { name })).toBeTruthy();
    }
  });

  it('当前页高亮，其他入口不高亮', async () => {
    await renderAt('/canvas');
    expect(within(mainNav()).getByRole('link', { name: '画布' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(mainNav()).getByRole('link', { name: '首页' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('收起后入口仍可用，刷新后保持收起', async () => {
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

describe('路由', () => {
  it('广场是沉浸式页面，不带侧栏，可以离开回首页', async () => {
    await renderAt('/plaza');
    expect(screen.queryByRole('navigation', { name: '主导航' })).toBeNull();
    expect(screen.getByRole('link', { name: '离开广场' }).getAttribute('href')).toBe('/');
  });

  it('未知地址显示 404 页', async () => {
    await renderAt('/no-such-page');
    expect(screen.getByRole('heading', { name: '没有这个页面' })).toBeTruthy();
  });
});
