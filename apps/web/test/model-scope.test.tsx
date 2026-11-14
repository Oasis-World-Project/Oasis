// 「AI 们」页上的「只用国内模型」开关：读出当前状态；点一下开、再点一下关，每次都存到 agent。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelScopeToggle } from '../src/ui/ModelScopeToggle.tsx';
import { installFakeApi, json } from './fake-api.ts';

const PATH = '/agent/v1/settings';

describe('只用国内模型', () => {
  it('显示当前状态；点一下打开、再点一下关上，每次都存下来', async () => {
    let domesticOnly = false;
    const api = installFakeApi({
      signedIn: true,
      extra: (method, path, body) => {
        if (path !== PATH) return undefined;
        if (method === 'PUT') ({ domesticOnly } = body as { domesticOnly: boolean });
        return json(200, { domesticOnly });
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelScopeToggle />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole<HTMLButtonElement>('switch', {
      name: /只用国内模型/,
    });
    const settled = (checked: string) =>
      waitFor(() => {
        expect(toggle.disabled).toBe(false);
        expect(toggle.getAttribute('aria-checked')).toBe(checked);
      });
    await settled('false');
    expect(toggle.textContent).toContain('所有模型都能用');
    fireEvent.click(toggle);
    await settled('true');
    expect(toggle.textContent).toContain('国外厂商的 AI 先暂停');
    fireEvent.click(toggle);
    await settled('false');
    expect(api.bodies.filter((b) => b.path === PATH).map((b) => b.body)).toEqual([
      { domesticOnly: true },
      { domesticOnly: false },
    ]);
  });

  it('读不到开关：按钮不能点，提示没连上', async () => {
    installFakeApi({
      signedIn: true,
      extra: (_method, path) =>
        path === PATH
          ? json(503, { error: { code: 'unavailable', message: '不可用' } })
          : undefined,
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ModelScopeToggle />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole<HTMLButtonElement>('switch');
    await waitFor(() => expect(toggle.textContent).toContain('没连上，稍后再试'));
    expect(toggle.disabled).toBe(true);
  });
});
