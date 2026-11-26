// 测试用的假后端：按路径应答 /api 请求，可切换登录状态。
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';
import { vi } from 'vitest';

const NOW = '2026-10-22T08:00:00.000Z';
export const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'kai@example.com',
  createdAt: NOW,
  accountNo: '38602741',
  name: '阿凯',
  bio: '',
  gender: '',
  region: '',
  avatarVersion: 0,
};

/** 一个人的公开资料（好友、申请、按账号 ID 查到的人） */
export const profileOf = (id: string, name: string, accountNo = '20000002') => ({
  id,
  accountNo,
  name,
  bio: '',
  gender: '',
  region: '',
  avatarVersion: 0,
});

export const MODELS = [
  {
    key: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    category: 'llm',
    tags: ['写作'],
    mono: 'Cl',
    glow: 'var(--oasis-glow-1)',
    options: [
      { tier: 'fast', label: 'Claude Haiku 5.5', inputPrice: 0.1, outputPrice: 0.5 },
      { tier: 'strong', label: 'Claude Opus 5.5', inputPrice: 4, outputPrice: 20, note: '慢一些' },
    ],
    tier: 'fast',
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
    options: [],
    tier: null,
    versionLabel: null,
    available: false,
  },
  {
    key: 'bytedance-seed/seedream-5-0-pro',
    name: 'Seedream 5.0 Pro',
    vendor: '字节跳动',
    category: 'image',
    tags: ['生图'],
    mono: 'Se',
    glow: 'var(--oasis-glow-2)',
    options: [],
    tier: null,
    versionLabel: null,
    available: false,
    usage: '生图时先用它',
  },
];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthorized = () => json(401, { error: { code: 'unauthorized', message: '请先登录' } });

/** 私聊没写在哪干活、权限的，按没设过算：云端沙箱、云端的默认权限 */
const withSetup = (dm: unknown) => ({
  workplace: { kind: 'cloud' },
  permissions: { mode: 'auto' },
  ...(dm as object),
});

/**
 * 和 AI 的私聊在页面上是一个房间（读消息、连推送用群的接口）：测试给的是私聊的消息和这一轮
 * （GET …/conversations/:id/messages），这里拼成房间的样子。
 */
function dmRoom(
  dm: { id: string; modelKey?: string; title?: string; workplace?: unknown; permissions?: unknown },
  list: { messages: { role: string }[]; turn: { runId: string; startedAt: string } | null },
) {
  const key = dm.modelKey ?? 'claude';
  const title = dm.title ?? MODELS.find((model) => model.key === key)?.name ?? key;
  return {
    id: dm.id,
    kind: 'dm',
    title,
    ownerId: USER.id,
    memberCount: 1,
    aiCount: 1,
    light: 'coral',
    createdAt: NOW,
    options: { light: 'coral', speak: 'mention' },
    historyNotice: GROUP_HISTORY_NOTICE,
    members: [{ userId: USER.id, displayName: USER.name, joinedAt: NOW }],
    ais: [
      {
        key,
        role: '',
        runId: list.turn?.runId ?? null,
        startedAt: list.turn?.startedAt ?? null,
        callers: list.turn ? [USER.id] : [],
        heardSeq: 0,
      },
    ],
    messages: list.messages.map((message, index) => ({
      ...message,
      seq: index + 1,
      authorId: message.role === 'user' ? USER.id : key,
      displayName: message.role === 'user' ? USER.name : title,
    })),
    home: withSetup({}),
    ...withHome(dm),
    confirmations: (list.turn as { confirmations?: unknown[] } | null)?.confirmations ?? [],
  };
}
const withHome = (dm: { workplace?: unknown; permissions?: unknown }) =>
  dm.workplace && dm.permissions
    ? { home: { workplace: dm.workplace, permissions: dm.permissions } }
    : {};

/** 测试自己加的接口：返回 undefined 表示不管，交给默认应答 */
export type ExtraRoute = (
  method: string,
  path: string,
  body: unknown,
) => Response | Promise<Response> | undefined;

export function installFakeApi(options: {
  signedIn: boolean;
  dms?: unknown[];
  /** 私聊里的任务（画布按任务分框） */
  tasks?: unknown[];
  /** 好友和申请（GET /conversation/v1/friends 的返回）；不给就是都没有 */
  friends?: unknown;
  extra?: ExtraRoute;
}) {
  const state = {
    signedIn: options.signedIn,
    requests: [] as string[],
    bodies: [] as { path: string; body: unknown }[],
  };
  const handler = vi.fn(
    async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
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
      const room = /^\/conversation\/v1\/groups\/([0-9a-f-]{36})(\?.*)?$/.exec(path);
      if (method === 'GET' && room) {
        // 没人管的房间：按和 AI 的私聊算，用测试给的私聊消息拼
        const list = await handler(`/api/conversation/v1/conversations/${room[1]}/messages`);
        if (!list.ok) return list;
        const dms = (options.dms ?? []) as { id: string }[];
        return json(
          200,
          dmRoom(
            dms.find((dm) => dm.id === room[1]) ?? { id: room[1]! },
            (await list.json()) as Parameters<typeof dmRoom>[1],
          ),
        );
      }
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
          return json(200, { conversations: (options.dms ?? []).map(withSetup) });
        case '/conversation/v1/groups':
          return json(200, { groups: [] });
        case '/conversation/v1/friends':
          return json(200, options.friends ?? { friends: [], incoming: [], outgoing: [] });
        case '/conversation/v1/tasks':
          return json(200, { tasks: options.tasks ?? [] });
        // 「AI 们」页读「只用国内模型」开关：默认关着
        case '/agent/v1/settings':
          return json(200, { domesticOnly: false });
        default:
          return json(404, { error: { code: 'not_found', message: '没有这个接口' } });
      }
    },
  );
  vi.stubGlobal('fetch', handler);
  return state;
}
