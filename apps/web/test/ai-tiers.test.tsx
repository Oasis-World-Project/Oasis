// 「AI 们」页上给 AI 换档位：默认快速；点「强力」存到 agent，卡片上换成新型号和它的标价；没接入的 AI 不能换。
import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.tsx';
import { installFakeApi, json, MODELS } from './fake-api.ts';

const PATH = '/agent/v1/models/claude/tier';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderAis() {
  const { App, router } = createApp({
    history: createMemoryHistory({ initialEntries: ['/ais'] }),
  });
  await act(() => router.load());
  render(<App />);
}

describe('给 AI 换档位', () => {
  it('默认快速；点「强力」存下来，卡片上换成新型号和标价', async () => {
    const api = installFakeApi({
      signedIn: true,
      extra: (method, path, body) => {
        if (method !== 'PUT' || path !== PATH) return undefined;
        const { tier } = body as { tier: string };
        return json(200, { ...MODELS[0], tier, versionLabel: 'Claude Opus 5.5' });
      },
    });
    await renderAis();
    const tiers = await screen.findByRole('radiogroup', { name: 'Claude 用哪一档' });
    const card = tiers.closest('article') as HTMLElement;
    expect(within(tiers).getByRole('radio', { name: '快速' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(card).getByText(/输入 \$0\.10 · 输出 \$0\.50/)).toBeTruthy();

    fireEvent.click(within(tiers).getByRole('radio', { name: '强力' }));
    await waitFor(() =>
      expect(within(tiers).getByRole('radio', { name: '强力' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    expect(within(card).getByText('Claude Opus 5.5')).toBeTruthy();
    expect(
      within(card).getByText(/输入 \$4\.00 · 输出 \$20\.00 \/ 百万 token · 慢一些/),
    ).toBeTruthy();
    expect(api.bodies.filter((b) => b.path === PATH).map((b) => b.body)).toEqual([
      { tier: 'strong' },
    ]);
  });

  it('换失败：留在原来的档位，提示重试；没接入的 AI 没有档位可换', async () => {
    installFakeApi({
      signedIn: true,
      extra: (method, path) =>
        method === 'PUT' && path === PATH
          ? json(503, { error: { code: 'unavailable', message: '不可用' } })
          : undefined,
    });
    await renderAis();
    const tiers = await screen.findByRole('radiogroup', { name: 'Claude 用哪一档' });
    fireEvent.click(within(tiers).getByRole('radio', { name: '强力' }));
    expect(await screen.findByText('没换成，请重试')).toBeTruthy();
    expect(within(tiers).getByRole('radio', { name: '快速' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.queryByRole('radiogroup', { name: '文心 用哪一档' })).toBeNull();
  });
});
