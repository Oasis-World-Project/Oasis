// 测试用的假后端：按路径应答 /api 请求，可切换登录状态。
import { vi } from 'vitest';

const NOW = '2026-10-22T08:00:00.000Z';
const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'kai@example.com',
  createdAt: NOW,
};

const MODELS = [
  {
    key: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    category: 'llm',
    tags: ['写作'],
    mono: 'Cl',
    glow: 'var(--oasis-glow-1)',
    versionLabel: 'Claude Haiku 5.5',
    available: true,
  },
  {
    key: 'ernie',
    name: '文心',
    vendor: '百度',
    category: 'llm',
    tags: ['中文'],
    mono: '文',
    glow: 'var(--oasis-glow-2)',
    versionLabel: null,
    available: false,
  },
];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthorized = () => json(401, { error: { code: 'unauthorized', message: '请先登录' } });

/** 测试自己加的接口：返回 undefined 表示不管，交给默认应答 */
export type ExtraRoute = (
  method: string,
  path: string,
  body: unknown,
) => Response | Promise<Response> | undefined;

export function installFakeApi(options: {
  signedIn: boolean;
  dms?: unknown[];
  extra?: ExtraRoute;
}) {
  const state = {
    signedIn: options.signedIn,
    requests: [] as string[],
    bodies: [] as { path: string; body: unknown }[],
  };
  const handler = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const path = input.replace(/^\/api/, '');
    state.requests.push(`${method} ${path}`);
    if (method === 'POST' && path === '/identity/v1/auth/email-code')
      return new Response(null, { status: 204 });
    if (method === 'POST' && path === '/identity/v1/auth/verify') {
      state.signedIn = true;
      return json(200, { user: USER, isNewUser: true });
    }
    if (!state.signedIn) return unauthorized();
    const body: unknown = init?.body ? JSON.parse(init.body) : undefined;
    if (body !== undefined) state.bodies.push({ path, body });
    const custom = await options.extra?.(method, path, body);
    if (custom) return custom;
    switch (path) {
      case '/identity/v1/me':
        return json(200, USER);
      case '/billing/v1/wallet':
        return json(200, {
          availableMicro: 30_000_000,
          heldMicro: 0,
          grantedMicro: 30_000_000,
          spentThisMonthMicro: 0,
        });
      case '/agent/v1/models':
        return json(200, { models: MODELS });
      case '/conversation/v1/dms':
        return json(200, { conversations: options.dms ?? [] });
      default:
        return json(404, { error: { code: 'not_found', message: '没有这个接口' } });
    }
  });
  vi.stubGlobal('fetch', handler);
  return state;
}
