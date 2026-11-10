// 模型范围（ADR 0027）：「只用国内模型」按用户存；替他列模型时只留国内厂商的，关着或不替谁列时不过滤。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createModelScopeService } from '../src/service/model-scope.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const saved = new Map<string, boolean>();
const scope = createModelScopeService({
  repo: {
    domesticOnly: async (userId) => saved.get(userId) ?? false,
    setDomesticOnly: async (userId, domesticOnly) => {
      saved.set(userId, domesticOnly);
    },
  },
  domesticVendors: ['deepseek', 'qwen'],
});
const app = Fastify({ loggerInstance: pino({ level: 'silent' }) });

beforeAll(() => {
  registerRoutes(app, {
    modelRequestMaxBytes: 1024,
    scope,
    executionModels: async () => [
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'google/gemini-4-argon' },
      { id: 'qwen/qwen3.8-max' },
    ],
  } as unknown as Parameters<typeof registerRoutes>[1]);
});
afterAll(() => app.close());
beforeEach(() => saved.clear());

const models = async (userId?: string) =>
  (
    await app.inject({
      url: '/internal/v1/models/execution',
      ...(userId ? { headers: { [OASIS_HEADERS.payerId]: userId } } : {}),
    })
  )
    .json<{ models: { id: string }[] }>()
    .models.map((m) => m.id);

describe('模型范围', () => {
  it('默认关着：不过滤；打开后只给这个用户留国内厂商的模型，别的用户和平台自己看不受影响', async () => {
    const allowed = async (userId?: string) =>
      ['deepseek/x', 'openai/y', 'nopslash'].filter(await scope.filterFor(userId));
    expect(await scope.get(USER)).toEqual({ domesticOnly: false });
    expect(await allowed(USER)).toEqual(['deepseek/x', 'openai/y', 'nopslash']);
    expect(await scope.set(USER, { domesticOnly: true })).toEqual({ domesticOnly: true });
    expect(await allowed(USER)).toEqual(['deepseek/x']);
    expect(await allowed(OTHER)).toHaveLength(3);
    expect(await allowed(undefined)).toHaveLength(3);
  });

  it('接口：读、写开关；能执行的模型按请求头里的用户过滤', async () => {
    const path = `/internal/v1/model-scopes/${USER}`;
    expect((await app.inject({ url: path })).json()).toEqual({ domesticOnly: false });
    expect(await models(USER)).toHaveLength(3);
    const put = await app.inject({ method: 'PUT', url: path, payload: { domesticOnly: true } });
    expect(put.json()).toEqual({ domesticOnly: true });
    expect((await app.inject({ url: path })).json()).toEqual({ domesticOnly: true });
    expect(await models(USER)).toEqual(['deepseek/deepseek-v4-pro', 'qwen/qwen3.8-max']);
    expect(await models()).toHaveLength(3);
    expect(await models(OTHER)).toHaveLength(3);
    const bad = await app.inject({ method: 'PUT', url: path, payload: { domesticOnly: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});
