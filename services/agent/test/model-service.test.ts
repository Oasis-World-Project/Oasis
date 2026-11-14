import { describe, expect, it } from 'vitest';
import type { ModelRepo, ModelRow, UserAiPrefs } from '../src/repo/model-repo.ts';
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
const fast = {
  model: 'vendor/ok-flash',
  label: 'Ok Flash',
  tier: 'fast' as const,
  inputPrice: 0.1,
  outputPrice: 0.4,
};
const strong = {
  model: 'vendor/ok-pro',
  label: 'Ok Pro',
  tier: 'strong' as const,
  inputPrice: 1,
  outputPrice: 4,
  note: '做任务更稳',
};
const ok: ModelRow = { ...base, key: 'ok', name: 'Ok', options: [fast, strong] };
const rows: ModelRow[] = [ok, { ...base, key: 'later', name: '以后', options: [] }];

function fakeRepo(): ModelRepo {
  const saved = new Map<string, UserAiPrefs>();
  const prefs = (userId: string) => saved.get(userId) ?? { domesticOnly: false, tiers: {} };
  return {
    list: async () => rows,
    find: async (key) => rows.find((r) => r.key === key),
    settings: async (userId) => prefs(userId),
    saveSettings: async (userId, settings) => {
      saved.set(userId, { ...prefs(userId), ...settings });
    },
    saveTier: async (userId, key, tier) => {
      const current = prefs(userId);
      saved.set(userId, { ...current, tiers: { ...current.tiers, [key]: tier } });
    },
  };
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return (err as { code: string }).code;
  }
  return 'no-error';
}

describe('模型目录', () => {
  it('默认用第一个型号；没有可选型号的不可用；对外不暴露上游型号 ID', async () => {
    const list = await createModelService(fakeRepo()).list(USER);
    expect(list.map((m) => [m.key, m.available, m.tier, m.versionLabel])).toEqual([
      ['ok', true, 'fast', 'Ok Flash'],
      ['later', false, null, null],
    ]);
    expect(list[0]?.options).toEqual([
      { tier: 'fast', label: 'Ok Flash', inputPrice: 0.1, outputPrice: 0.4 },
      { tier: 'strong', label: 'Ok Pro', inputPrice: 1, outputPrice: 4, note: '做任务更稳' },
    ]);
    expect(JSON.stringify(list)).not.toContain('vendor/');
  });

  it('开一轮的路由带上游型号、默认人设和这个用户的「只用国内模型」', async () => {
    const service = createModelService(fakeRepo());
    expect(await service.route('ok', USER)).toEqual({
      key: 'ok',
      name: 'Ok',
      providerModel: 'vendor/ok-flash',
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

  it('换档位：目录显示选的型号，下一轮用它；别的用户不受影响；只能选有的档位', async () => {
    const service = createModelService(fakeRepo());
    const chosen = await service.chooseTier(USER, 'ok', 'strong');
    expect([chosen.tier, chosen.versionLabel]).toEqual(['strong', 'Ok Pro']);
    expect((await service.list(USER))[0]?.versionLabel).toBe('Ok Pro');
    expect((await service.route('ok', USER)).providerModel).toBe('vendor/ok-pro');
    expect((await service.route('ok', OTHER)).providerModel).toBe('vendor/ok-flash');
    // 换档位不动「只用国内模型」
    expect(await service.settings(USER)).toEqual({ domesticOnly: false });
    expect(await errorCode(service.chooseTier(USER, 'ok', 'max'))).toBe('tier_not_offered');
    expect(await errorCode(service.chooseTier(USER, 'nope', 'fast'))).toBe('model_not_found');
  });

  it('选的那一档下架了：回到默认型号', async () => {
    const repo = fakeRepo();
    const service = createModelService(repo);
    await service.chooseTier(USER, 'ok', 'strong');
    const withoutStrong: ModelRow = { ...ok, options: [fast] };
    const shrunk = createModelService({
      ...repo,
      list: async () => [withoutStrong],
      find: async () => withoutStrong,
    });
    expect((await shrunk.list(USER))[0]?.tier).toBe('fast');
    expect((await shrunk.route('ok', USER)).providerModel).toBe('vendor/ok-flash');
  });

  it('不存在或未接入的模型给出明确错误', async () => {
    const service = createModelService(fakeRepo());
    expect(await errorCode(service.route('nope', USER))).toBe('model_not_found');
    expect(await errorCode(service.route('later', USER))).toBe('model_unavailable');
  });
});
