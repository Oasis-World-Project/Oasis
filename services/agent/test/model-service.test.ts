import { describe, expect, it } from 'vitest';
import type { AiSettings } from '@oasis/contracts/agent';
import type { ModelRepo, ModelRow } from '../src/repo/model-repo.ts';
import { createModelService, defaultSystemPrompt } from '../src/service/model-service.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
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
const saved = new Map<string, AiSettings>();
const repo: ModelRepo = {
  list: async () => rows,
  find: async (key) => rows.find((r) => r.key === key),
  settings: async (userId) => saved.get(userId) ?? { domesticOnly: false },
  saveSettings: async (userId, settings) => {
    saved.set(userId, settings);
  },
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
  it('没有上游模型的标记为不可用，对外不暴露上游模型 ID', async () => {
    const list = await createModelService(repo).list();
    expect(list.map((m) => [m.key, m.available])).toEqual([
      ['ok', true],
      ['later', false],
    ]);
    expect(JSON.stringify(list)).not.toContain('vendor/ok-1');
  });

  it('开一轮的路由带上游模型 ID、默认人设和这个用户的「只用国内模型」', async () => {
    const service = createModelService(repo);
    expect(await service.route('ok', USER)).toEqual({
      key: 'ok',
      name: 'Ok',
      providerModel: 'vendor/ok-1',
      systemPrompt: defaultSystemPrompt('Ok'),
      domesticOnly: false,
    });
    expect(await service.saveSettings(USER, { domesticOnly: true })).toEqual({
      domesticOnly: true,
    });
    expect(await service.settings(USER)).toEqual({ domesticOnly: true });
    expect((await service.route('ok', USER)).domesticOnly).toBe(true);
    // 别的用户不受影响
    expect((await service.route('ok', OTHER)).domesticOnly).toBe(false);
  });

  it('不存在或未接入的模型给出明确错误', async () => {
    const service = createModelService(repo);
    expect(await errorCode(service.route('nope', USER))).toBe('model_not_found');
    expect(await errorCode(service.route('later', USER))).toBe('model_unavailable');
  });
});
