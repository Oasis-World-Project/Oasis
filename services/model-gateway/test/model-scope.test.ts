// 模型范围：「只用国内模型」存在 agent，开一轮时随临时 Key 带来；打开时只留国内厂商的模型，关着不过滤。
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createModelScope } from '../src/service/model-scope.ts';

const scope = createModelScope({ domesticVendors: ['deepseek', 'qwen'] });
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

const models = async (query = '') =>
  (await app.inject({ url: `/internal/v1/models/execution${query}` }))
    .json<{ models: { id: string }[] }>()
    .models.map((m) => m.id);

describe('模型范围', () => {
  it('打开时只留国内厂商的模型（按模型 ID 里「/」前面的厂商），关着不过滤', () => {
    const allowed = (domesticOnly: boolean | undefined) =>
      ['deepseek/x', 'openai/y', 'nopslash'].filter(scope.filterFor(domesticOnly));
    expect(allowed(true)).toEqual(['deepseek/x']);
    expect(allowed(false)).toHaveLength(3);
    expect(allowed(undefined)).toHaveLength(3);
  });

  it('能开一轮的执行模型按 ?domesticOnly 过滤；写错了是 400', async () => {
    expect(await models()).toHaveLength(3);
    expect(await models('?domesticOnly=false')).toHaveLength(3);
    expect(await models('?domesticOnly=true')).toEqual([
      'deepseek/deepseek-v4-pro',
      'qwen/qwen3.8-max',
    ]);
    expect(
      (await app.inject({ url: '/internal/v1/models/execution?domesticOnly=yes' })).statusCode,
    ).toBe(400);
  });
});
