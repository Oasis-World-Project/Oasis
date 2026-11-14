// 一个 AI 的设置页：换档位、起名字、写人格，保存到 agent；改了没存时底部写着改了几处，可以放弃；
// 存不上时提示、改的东西还在。没开放的（技能、知识库、自己的音源）标着即将开放。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, MODELS } from './fake-api.ts';

const PATH = '/agent/v1/models/claude/settings';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderSettings() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: ['/ais/claude'] }),
  });
  await act(() => router.load());
  render(<App />);
}

const tiers = () => within(screen.getByRole('radiogroup', { name: '用哪一档' }));
const checked = () =>
  tiers()
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true')
    .map((r) => r.textContent);

describe('AI 的设置页', () => {
  it('换到强力、起名字、写人格，保存后下一轮生效；侧栏卡片跟着变', async () => {
    const api = installFakeApi({
      signedIn: true,
      extra: (method, path, body) => {
        if (method !== 'PUT' || path !== PATH) return undefined;
        const { tier, profile } = body as { tier: string; profile: object };
        return json(200, { ...MODELS[0], tier, versionLabel: 'Claude Opus 5.5', profile });
      },
    });
    await renderSettings();
    expect(await screen.findByRole('heading', { name: 'Claude 的设定' })).toBeTruthy();
    expect(checked()).toEqual([expect.stringContaining('Claude Haiku 5.5')]);
    expect(screen.getByRole('status').textContent).toBe('所有设定都已保存');

    fireEvent.click(tiers().getByRole('radio', { name: /Claude Opus 5\.5/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '名字' }), { target: { value: '阿光' } });
    fireEvent.change(screen.getByRole('textbox', { name: '人格描述' }), {
      target: { value: '说话简短。爱用比喻' },
    });
    expect(screen.getByRole('status').textContent).toBe('改了 3 处，还没保存');
    expect(screen.getByLabelText('它现在的样子').textContent).toContain('我是阿光。说话简短。');

    fireEvent.click(screen.getByRole('button', { name: '保存设定' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('所有设定都已保存'));
    expect(api.bodies.filter((b) => b.path === PATH).map((b) => b.body)).toEqual([
      { tier: 'strong', profile: { name: '阿光', persona: '说话简短。爱用比喻' } },
    ]);
    expect(checked()).toEqual([expect.stringContaining('Claude Opus 5.5')]);
    // 没开放的先放着
    expect(screen.getByRole('heading', { name: /技能和连接器/ }).textContent).toContain('即将开放');
    expect(screen.getByRole('heading', { name: /知识库/ }).textContent).toContain('即将开放');
  });

  it('存不上：提示、改的东西还在；放弃修改回到存过的；恢复系统默认清空设定', async () => {
    installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'PUT' && path === PATH
          ? json(503, { error: { code: 'unavailable', message: '不可用' } })
          : undefined,
    });
    await renderSettings();
    const name = await screen.findByRole('textbox', { name: '名字' });
    fireEvent.change(name, { target: { value: '小克' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设定' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('请求失败'));
    expect((name as HTMLInputElement).value).toBe('小克');

    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect((name as HTMLInputElement).value).toBe('');
    fireEvent.click(tiers().getByRole('radio', { name: /Claude Opus 5\.5/ }));
    fireEvent.click(screen.getByRole('button', { name: '全部恢复成系统默认' }));
    expect(checked()).toEqual([expect.stringContaining('Claude Haiku 5.5')]);
    expect(screen.getByRole('status').textContent).toBe('所有设定都已保存');
  });

  it('没接入的、不是对话 AI 的没有设置页', async () => {
    installFakeApi({ signedIn: true });
    const { App, router } = createApp({
      history: createMemoryHistory({ initialEntries: ['/ais/ernie'] }),
    });
    await act(() => router.load());
    render(<App />);
    expect(await screen.findByText('没有这个 AI，回「AI 们」看看。')).toBeTruthy();
  });
});
