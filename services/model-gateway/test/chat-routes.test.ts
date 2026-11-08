// 模型调用的 HTTP 入口：请求体容量和运行凭据，内部入口与运行入口行为一致。
import { createHttpServer, HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { modelGatewayEnv } from '../src/config.ts';
import type { createDecisionService } from '../src/service/decision-service.ts';
import {
  fake,
  PAYER,
  RUN,
  billingCalls,
  started,
  finished,
  silent,
  chat,
  request,
} from './support/chat-fixture.ts';

describe('模型 HTTP 入口', () => {
  const limit = 2 * 1024 ** 2;
  function routes() {
    const app = createHttpServer({
      service: 'model-gateway',
      version: 'test',
      commit: 'test',
      logger: silent,
      resources: [],
      isShuttingDown: () => false,
    });
    registerRoutes(app, {
      modelRequestMaxBytes: limit,
      chat,
      decisions: {
        decide: async ({
          body,
        }: Parameters<ReturnType<typeof createDecisionService>['decide']>[0]) => ({
          state: body.state,
        }),
      },
      runKeys: {
        authenticate: async (authorization: string) => {
          if (authorization !== 'Bearer offline-key')
            throw new HttpError(401, 'invalid_run_key', '无效运行凭据');
          return { payerId: PAYER, runId: RUN };
        },
      },
    } as unknown as Parameters<typeof registerRoutes>[1]);
    return app;
  }
  const headers = { authorization: 'Bearer offline-key', 'x-oasis-payer-id': PAYER };

  it('模型请求配置默认与入口代理的 50 MiB 一致，并拒绝超出代理容量的配置', () => {
    expect(modelGatewayEnv.MODEL_REQUEST_MAX_BYTES.parse(undefined)).toBe(50 * 1024 ** 2);
    expect(() => modelGatewayEnv.MODEL_REQUEST_MAX_BYTES.parse(50 * 1024 ** 2 + 1)).toThrow();
  });

  it.each(['/internal/v1/chat/completions', '/run/v1/chat/completions'])(
    '%s 接受超过 1 MiB 的历史和内嵌图片，完整透传并结算一次',
    async (url) => {
      const app = routes();
      const body = {
        ...request,
        messages: [
          { role: 'user', content: 'historical context '.repeat(60_000) },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${Buffer.alloc(150_000).toString('base64')}`,
                },
              },
            ],
          },
        ],
      };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(1024 ** 2);
      try {
        const response = await app.inject({ method: 'POST', url, headers, payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('data: [DONE]');
        expect(fake.upstreamBodies).toEqual([expect.objectContaining({ messages: body.messages })]);
        expect(billingCalls.map((call) => call.path)).toEqual(['/internal/holds', 'settle']);
        expect(finished).toHaveLength(1);
      } finally {
        await app.close();
      }
    },
  );

  it.each(['/internal/v1/decisions', '/run/v1/decisions'])(
    '%s 同样允许大材料，避免压缩或验收再次撞上默认限制',
    async (url) => {
      const app = routes();
      const state = 'evidence '.repeat(130_000);
      try {
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { model: 'test', state, questions: {} },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state });
      } finally {
        await app.close();
      }
    },
  );

  it.each(['chat/completions', 'decisions'])(
    '超出配置容量的 %s 在调用和冻结前拒绝',
    async (route) => {
      const app = routes();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/run/v1/${route}`,
          headers,
          payload: { padding: 'x'.repeat(limit) },
        });
        expect(response.statusCode).toBe(413);
        expect(started).toHaveLength(0);
        expect(billingCalls).toHaveLength(0);
        expect(fake.upstreamBodies).toHaveLength(0);
      } finally {
        await app.close();
      }
    },
  );

  it('扩大容量后仍须验证运行凭据，未授权的大请求不冻结费用', async () => {
    const app = routes();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/run/v1/chat/completions',
        payload: { ...request, messages: [{ role: 'user', content: 'x'.repeat(1024 ** 2 + 1) }] },
      });
      expect(response.statusCode).toBe(401);
      expect(started).toHaveLength(0);
      expect(billingCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
