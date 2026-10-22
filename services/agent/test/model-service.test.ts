import { describe, expect, it } from 'vitest';
import type { ModelRepo, ModelRow } from '../src/repo/model-repo.ts';
import { createModelService, defaultSystemPrompt } from '../src/service/model-service.ts';

const base = {
  vendor: 'X',
  category: 'llm' as const,
  tags: ['测试'],
  mono: 'X',
  glow: '#000',
  sortOrder: 1,
  createdAt: new Date(),
};
const rows: ModelRow[] = [
  { ...base, key: 'ok', name: 'Ok', providerModel: 'vendor/ok-1', versionLabel: 'Ok 1' },
  { ...base, key: 'later', name: '以后', providerModel: null, versionLabel: null },
];
const repo: ModelRepo = {
  list: async () => rows,
  find: async (key) => rows.find((r) => r.key === key),
};

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return (err as { code: string }).code;
  }
  return 'no-error';
}

describe('模型目录', () => {
  it('规划员的目录只列已接入的模型，带上游模型 ID', async () => {
    const catalog = await createModelService(repo).catalog();
    expect(catalog.map((m) => [m.key, m.providerModel])).toEqual([['ok', 'vendor/ok-1']]);
  });

  it('没有上游模型的标记为不可用，对外不暴露上游模型 ID', async () => {
    const list = await createModelService(repo).list();
    expect(list.map((m) => [m.key, m.available])).toEqual([
      ['ok', true],
      ['later', false],
    ]);
    expect(JSON.stringify(list)).not.toContain('vendor/ok-1');
  });

  it('调用路由带上游模型 ID 和默认人设', async () => {
    expect(await createModelService(repo).route('ok')).toEqual({
      key: 'ok',
      name: 'Ok',
      providerModel: 'vendor/ok-1',
      systemPrompt: defaultSystemPrompt('Ok'),
    });
  });

  it('不存在或未接入的模型给出明确错误', async () => {
    const service = createModelService(repo);
    expect(await errorCode(service.route('nope'))).toBe('model_not_found');
    expect(await errorCode(service.route('later'))).toBe('model_unavailable');
  });
});
