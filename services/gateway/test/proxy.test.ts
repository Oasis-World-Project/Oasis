import { ErrorBody } from '@oasis/contracts/common';
import { createService, type Service } from '@oasis/service-kit';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gatewayService } from '../src/app.ts';

const upstream = Fastify();
upstream.get('/v1/echo', async (request) => ({
  url: request.url,
  requestId: request.headers['x-request-id'],
  oasisUser: request.headers['x-oasis-user-id'] ?? null,
}));
upstream.get('/health', async () => ({ status: 'ok' }));
upstream.get('/internal/secret', async () => ({ secret: true }));

let upstreamUrl = '';
let unreachableUrl = '';
let gateway: Service<typeof gatewayService.env> | undefined;

beforeAll(async () => {
  upstreamUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });
  // 开一个端口再关掉，得到一个确定没人监听的地址
  const closed = Fastify();
  unreachableUrl = await closed.listen({ port: 0, host: '127.0.0.1' });
  await closed.close();
});
afterAll(() => upstream.close());
afterEach(() => gateway?.stop());

async function startGateway(overrides: Record<string, string> = {}) {
  gateway = await createService(gatewayService, {
    PORT: '0',
    LOG_LEVEL: 'silent',
    IDENTITY_URL: upstreamUrl,
    BILLING_URL: unreachableUrl,
    AGENT_URL: unreachableUrl,
    CONVERSATION_URL: unreachableUrl,
    TASK_URL: unreachableUrl,
    CANVAS_URL: unreachableUrl,
    ...overrides,
  });
  return gateway.app;
}

describe('gateway 路由', () => {
  it('把 /api/<服务>/v1/* 转发到 <服务>/v1/*，并透传请求 ID', async () => {
    const app = await startGateway();
    const res = await app.inject({
      url: '/api/identity/v1/echo?x=1',
      headers: { 'x-request-id': 'req-7' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: '/v1/echo?x=1', requestId: 'req-7', oasisUser: null });
  });

  it('丢弃客户端伪造的 x-oasis-* 头', async () => {
    const app = await startGateway();
    const res = await app.inject({
      url: '/api/identity/v1/echo',
      headers: { 'x-oasis-user-id': 'admin' },
    });
    expect(res.json().oasisUser).toBeNull();
  });

  it.each([
    '/api/identity/health',
    '/api/identity/internal/secret',
    '/api/harness/v1/meta',
    '/api/model-gateway/v1/meta',
  ])('不对外开放：%s', async (url) => {
    const app = await startGateway();
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(ErrorBody.parse(res.json()).error.code).toBe('not_found');
  });

  it('某个上游不可用时只有它返回 503，其他服务照常', async () => {
    const app = await startGateway();
    const down = await app.inject('/api/billing/v1/echo');
    expect(down.statusCode).toBe(503);
    expect(ErrorBody.parse(down.json()).error.code).toBe('upstream_unavailable');
    const up = await app.inject('/api/identity/v1/echo');
    expect(up.statusCode).toBe(200);
  });

  it('上游地址缺失时拒绝启动', async () => {
    await expect(startGateway({ TASK_URL: '' })).rejects.toThrow(/TASK_URL/);
  });
});
