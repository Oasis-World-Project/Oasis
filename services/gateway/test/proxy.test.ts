import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorBody } from '@oasis/contracts/common';
import { createService, type Service } from '@oasis/service-kit';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { gatewayService } from '../src/app.ts';

const USER_ID = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const ORIGIN = 'http://127.0.0.1:5173';

/** 假的上游：同时扮演 identity（会话校验）和普通业务服务（回显收到的头）。 */
const upstream = Fastify();
let introspectCalls = 0;
upstream.post('/internal/sessions/introspect', async (request, reply) => {
  introspectCalls += 1;
  const { token } = request.body as { token: string };
  if (token === 'good-token') return { userId: USER_ID };
  return reply
    .code(401)
    .send({ error: { code: 'unauthenticated', message: '无效', requestId: 'r' } });
});
upstream.all('/v1/echo', async (request) => ({
  url: request.url,
  requestId: request.headers['x-request-id'],
  userId: request.headers['x-oasis-user-id'] ?? null,
  cookie: request.headers.cookie ?? null,
}));
upstream.post('/v1/auth/email-code', async (_request, reply) => reply.code(204).send());
upstream.get('/health', async () => ({ status: 'ok' }));
upstream.get('/internal/secret', async () => ({ secret: true }));
/** 扮演 model-gateway 给用户电脑上的 dsh 开的入口：回显收到的 Key 和头 */
upstream.all('/run/v1/*', async (request) => ({
  url: request.url,
  authorization: request.headers.authorization ?? null,
  userId: request.headers['x-oasis-user-id'] ?? null,
  cookie: request.headers.cookie ?? null,
}));

/** 假 harness：桌面版连上来时记下收到的地址和头，回一句 hello */
const harness = createServer((_request, response) => response.writeHead(404).end());
const devices = new WebSocketServer({ noServer: true });
const upgrades: { url?: string; userId?: string | string[]; cookie?: string }[] = [];
harness.on('upgrade', (request, socket, head) => {
  upgrades.push({
    url: request.url,
    userId: request.headers['x-oasis-user-id'],
    cookie: request.headers.cookie,
  });
  devices.handleUpgrade(request, socket, head, (ws) => ws.send('hello'));
});

let upstreamUrl = '';
let harnessUrl = '';
let unreachableUrl = '';
let gateway: Service<typeof gatewayService.env> | undefined;

beforeAll(async () => {
  upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => harness.listen(0, '127.0.0.1', resolve));
  harnessUrl = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;
  const closed = Fastify();
  unreachableUrl = await closed.listen({ port: 0, host: '127.0.0.1' });
  await closed.close();
});
afterAll(async () => {
  await upstream.close();
  devices.close();
  harness.close();
});
afterEach(() => gateway?.stop());

async function startGateway(overrides: Record<string, string> = {}) {
  gateway = await createService(gatewayService, {
    PORT: '0',
    LOG_LEVEL: 'silent',
    IDENTITY_URL: upstreamUrl,
    BILLING_URL: upstreamUrl,
    AGENT_URL: unreachableUrl,
    CONVERSATION_URL: unreachableUrl,
    CANVAS_URL: unreachableUrl,
    HARNESS_URL: harnessUrl,
    MODEL_GATEWAY_URL: upstreamUrl,
    GATEWAY_ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  });
  return gateway.app;
}

const signedIn = { cookie: 'theme=dark; oasis_session=good-token' };

describe('登录校验', () => {
  it('没登录访问业务接口返回 401', async () => {
    const app = await startGateway();
    const res = await app.inject('/api/billing/v1/echo');
    expect(res.statusCode).toBe(401);
    expect(ErrorBody.parse(res.json()).error.code).toBe('unauthenticated');
  });

  it('无效会话同样是 401', async () => {
    const app = await startGateway();
    const res = await app.inject({
      url: '/api/billing/v1/echo',
      headers: { cookie: 'oasis_session=bad' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('登录接口不需要会话', async () => {
    const app = await startGateway();
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/v1/auth/email-code',
      headers: { origin: ORIGIN },
      payload: { email: 'a@x.com' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('登录后把可信的用户 ID 交给上游；会话 Cookie 只给 identity', async () => {
    const app = await startGateway();
    const billing = await app.inject({
      url: '/api/billing/v1/echo?x=1',
      headers: { ...signedIn, 'x-request-id': 'req-7' },
    });
    expect(billing.json()).toEqual({
      url: '/v1/echo?x=1',
      requestId: 'req-7',
      userId: USER_ID,
      cookie: null,
    });
    const identity = await app.inject({ url: '/api/identity/v1/echo', headers: signedIn });
    expect(identity.json().cookie).toContain('oasis_session=good-token');
  });

  it('丢弃客户端伪造的 x-oasis-* 头', async () => {
    const app = await startGateway();
    const res = await app.inject({
      url: '/api/billing/v1/echo',
      headers: { ...signedIn, 'x-oasis-user-id': 'admin', 'x-oasis-payer-id': 'admin' },
    });
    expect(res.json().userId).toBe(USER_ID);
  });

  it('会话校验结果会缓存，不必每个请求都问 identity', async () => {
    const app = await startGateway();
    const before = introspectCalls;
    await app.inject({ url: '/api/billing/v1/echo', headers: signedIn });
    await app.inject({ url: '/api/billing/v1/echo', headers: signedIn });
    expect(introspectCalls - before).toBe(1);
  });
});

describe('防跨站请求伪造', () => {
  it.each([[undefined], ['https://evil.example']])(
    '改数据的请求来源不对（%s）返回 403',
    async (origin) => {
      const app = await startGateway();
      const headers: Record<string, string> = { ...signedIn };
      if (origin) headers.origin = origin;
      const res = await app.inject({
        method: 'POST',
        url: '/api/billing/v1/echo',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(ErrorBody.parse(res.json()).error.code).toBe('forbidden_origin');
    },
  );

  it('来源正确时放行', async () => {
    const app = await startGateway();
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/v1/echo',
      headers: { ...signedIn, origin: ORIGIN },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('路由', () => {
  it.each([
    '/api/identity/health',
    '/api/identity/internal/secret',
    '/api/harness/v1/meta',
    '/api/model-gateway/v1/meta',
  ])('不对外开放：%s', async (url) => {
    const app = await startGateway();
    const res = await app.inject({ url, headers: signedIn });
    expect(res.statusCode).toBe(404);
  });

  it('某个上游不可用时只有它返回 503，其他服务照常', async () => {
    const app = await startGateway();
    const down = await app.inject({ url: '/api/canvas/v1/echo', headers: signedIn });
    expect(down.statusCode).toBe(503);
    expect(ErrorBody.parse(down.json()).error.code).toBe('upstream_unavailable');
    const up = await app.inject({ url: '/api/billing/v1/echo', headers: signedIn });
    expect(up.statusCode).toBe(200);
  });

  it('上游地址缺失时拒绝启动', async () => {
    await expect(startGateway({ CANVAS_URL: '' })).rejects.toThrow(/CANVAS_URL/);
  });
});

describe('在用户电脑上干活', () => {
  it('电脑上的 dsh 调模型：不要登录、不查来源，带着这一轮的 Key 转给 model-gateway，不带 Cookie 和 x-oasis-* 头', async () => {
    const app = await startGateway();
    const res = await app.inject({
      method: 'POST',
      url: '/api/run/v1/chat/completions',
      headers: { ...signedIn, authorization: 'Bearer run-key', 'x-oasis-user-id': 'admin' },
      payload: { model: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: '/run/v1/chat/completions',
      authorization: 'Bearer run-key',
      userId: null,
      cookie: null,
    });
  });

  it('桌面版连 harness：要登录、来源要对；转过去只带是谁，不带 Cookie', async () => {
    await startGateway();
    const address = (await gateway!.listen()).replace(/^http/, 'ws');
    const open = (headers: Record<string, string>) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${address}/api/harness/v1/devices/connect?device=desk-0001`, {
          headers,
        });
        ws.once('message', (data) => {
          resolve(String(data));
          ws.close();
        });
        ws.once('error', reject);
      });
    await expect(open({ origin: ORIGIN })).rejects.toThrow('401');
    await expect(open({ ...signedIn, origin: 'https://evil.example' })).rejects.toThrow('403');
    expect(upgrades).toEqual([]);
    expect(await open({ ...signedIn, origin: ORIGIN })).toBe('hello');
    expect(upgrades).toEqual([
      { url: '/v1/devices/connect?device=desk-0001', userId: USER_ID, cookie: undefined },
    ]);
  });
});
