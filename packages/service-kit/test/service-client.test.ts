import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServiceClient, HttpError } from '../src/index.ts';

const upstream = Fastify();
upstream.get('/ok', async (request) => ({ value: 42, requestId: request.headers['x-request-id'] }));
upstream.get('/missing', async (_request, reply) =>
  reply.code(404).send({ error: { code: 'not_found', message: '没有', requestId: 'r' } }),
);
upstream.get('/boom', async (_request, reply) => reply.code(500).send({ oops: true }));
upstream.get('/not-configured', async (_request, reply) =>
  reply
    .code(503)
    .send({ error: { code: 'provider_not_configured', message: '没配置', requestId: 'r' } }),
);
upstream.post('/empty', async (_request, reply) => reply.code(204).send());

let baseUrl = '';
beforeAll(async () => {
  baseUrl = await upstream.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => upstream.close());

async function capture(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HttpError) return err;
  }
  throw new Error('应该抛出 HttpError');
}

describe('服务间调用客户端', () => {
  it('成功时按 schema 校验响应，并带上请求 ID', async () => {
    const client = createServiceClient('demo', baseUrl);
    const result = await client.json('GET', '/ok', {
      requestId: 'req-1',
      schema: z.object({ value: z.number(), requestId: z.string() }),
    });
    expect(result).toEqual({ value: 42, requestId: 'req-1' });
  });

  it('对方的 4xx 原样抛出', async () => {
    const err = await capture(createServiceClient('demo', baseUrl).json('GET', '/missing'));
    expect([err.statusCode, err.code]).toEqual([404, 'not_found']);
  });

  it('对方 5xx 变成 502，连不上变成 503', async () => {
    const err = await capture(createServiceClient('demo', baseUrl).json('GET', '/boom'));
    expect([err.statusCode, err.code]).toEqual([502, 'upstream_error']);
    const down = await capture(
      createServiceClient('demo', 'http://127.0.0.1:9').json('GET', '/ok'),
    );
    expect([down.statusCode, down.code]).toEqual([503, 'upstream_unavailable']);
  });

  it('对方 5xx 带标准错误体时保留 code', async () => {
    const err = await capture(createServiceClient('demo', baseUrl).json('GET', '/not-configured'));
    expect([err.statusCode, err.code]).toEqual([503, 'provider_not_configured']);
  });

  it('204 返回 undefined', async () => {
    expect(
      await createServiceClient('demo', baseUrl).json('POST', '/empty', { body: {} }),
    ).toBeUndefined();
  });
});
