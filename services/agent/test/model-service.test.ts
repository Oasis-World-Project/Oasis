import { CHAT_AIS, TOOL_LINEUP, type ChatAi } from '@oasis/contracts/lineup';
import { describe, expect, it } from 'vitest';
import type { ModelRepo, UserAiPrefs } from '../src/repo/model-repo.ts';
import { createModelService, systemPrompt } from '../src/service/model-service.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const base = { vendor: 'X', tags: ['测试'], mono: 'X', glow: '#000' };
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
const ok: ChatAi = { ...base, key: 'ok', name: 'Ok', options: [fast, strong] };
const AIS: ChatAi[] = [ok, { ...base, key: 'later', name: '以后', options: [] }];

function fakeRepo(): ModelRepo {
  const saved = new Map<string, UserAiPrefs>();
  const prefs = (userId: string) =>
    saved.get(userId) ?? { domesticOnly: false, tiers: {}, profiles: {} };
  return {
    settings: async (userId) => prefs(userId),
    saveSettings: async (userId, settings) => {
      saved.set(userId, { ...prefs(userId), ...settings });
    },
    saveAi: async (userId, key, tier, profile) => {
      const current = prefs(userId);
      saved.set(userId, {
        ...current,
        tiers: { ...current.tiers, [key]: tier },
        profiles: { ...current.profiles, [key]: profile },
      });
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

const chat = <T extends { category: string }>(list: T[]) =>
  list.filter((m) => m.category === 'llm');

describe('AI 们', () => {
  it('默认用第一个型号；没有可选型号的不能私聊；对外不暴露上游型号 ID', async () => {
    const list = chat(await createModelService(fakeRepo(), AIS).list(USER));
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

  it('各工具用的型号按类列出、只能看：同一个型号给几个工具用就写在一起，写着排第几', async () => {
    const tools = (await createModelService(fakeRepo(), AIS).list(USER)).filter(
      (m) => m.category !== 'llm',
    );
    const first = TOOL_LINEUP.image.models[0]!;
    expect(tools.find((m) => m.key === first.id)).toMatchObject({
      name: first.name,
      category: 'image',
      available: false,
      tags: ['生图'],
      usage: '生图时先用它',
    });
    expect(tools.find((m) => m.key === TOOL_LINEUP.video.models[2]!.id)?.usage).toBe(
      '生视频排第 3 个',
    );
    // 问另一个模型、数字人用的本来就是对话 AI 的型号，不在这里重复列
    expect(tools.some((m) => m.key === 'openai/gpt-6.1-sol')).toBe(false);
    expect(new Set(tools.map((m) => m.key)).size).toBe(tools.length);
  });

  it('清单里每个对话 AI 第一档是快速、每档最多一个；型号 ID 都带厂商前缀', () => {
    expect(CHAT_AIS.length).toBe(15);
    for (const ai of CHAT_AIS) {
      expect(ai.options[0]?.tier).toBe('fast');
      expect(new Set(ai.options.map((o) => o.tier)).size).toBe(ai.options.length);
      for (const option of ai.options) expect(option.model).toMatch(/^[a-z0-9-]+\/[a-z0-9.:-]+$/);
    }
    expect(CHAT_AIS.map((ai) => ai.key)).not.toContain('spark');
  });

  it('开一轮的路由带上游型号、人设和这个用户的「只用国内模型」', async () => {
    const service = createModelService(fakeRepo(), AIS);
    expect(await service.route('ok', USER)).toEqual({
      key: 'ok',
      name: 'Ok',
      providerModel: 'vendor/ok-flash',
      systemPrompt: systemPrompt('Ok'),
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

  it('设置页保存：换档位和设定，下一轮用新型号、带上名字和人格；别的用户不受影响', async () => {
    const service = createModelService(fakeRepo(), AIS);
    const profile = {
      name: '阿光',
      gender: 'male' as const,
      persona: '说话简短',
      notes: '周末别催我',
    };
    const saved = await service.save(USER, 'ok', { tier: 'strong', profile });
    expect([saved.tier, saved.versionLabel, saved.profile]).toEqual(['strong', 'Ok Pro', profile]);
    expect(chat(await service.list(USER))[0]).toMatchObject({ versionLabel: 'Ok Pro', profile });
    const route = await service.route('ok', USER);
    expect(route).toMatchObject({ name: '阿光', providerModel: 'vendor/ok-pro' });
    expect(route.systemPrompt).toContain('你是 阿光');
    expect(route.systemPrompt).toContain('说话简短');
    expect(route.systemPrompt).toContain('周末别催我');
    expect(route.systemPrompt).toContain('男性');
    expect(await service.route('ok', OTHER)).toMatchObject({
      name: 'Ok',
      providerModel: 'vendor/ok-flash',
      systemPrompt: systemPrompt('Ok'),
    });
    // 恢复默认：设定清空
    await service.save(USER, 'ok', { tier: 'fast', profile: {} });
    expect((await service.route('ok', USER)).systemPrompt).toBe(systemPrompt('Ok'));
    expect(await errorCode(service.save(USER, 'ok', { tier: 'max', profile: {} }))).toBe(
      'tier_not_offered',
    );
    expect(await errorCode(service.save(USER, 'nope', { tier: 'fast', profile: {} }))).toBe(
      'model_not_found',
    );
  });

  it('选的那一档下架了：回到默认型号', async () => {
    const repo = fakeRepo();
    await createModelService(repo, AIS).save(USER, 'ok', { tier: 'strong', profile: {} });
    const shrunk = createModelService(repo, [{ ...ok, options: [fast] }]);
    expect(chat(await shrunk.list(USER))[0]?.tier).toBe('fast');
    expect((await shrunk.route('ok', USER)).providerModel).toBe('vendor/ok-flash');
  });

  it('不存在或未接入的模型给出明确错误', async () => {
    const service = createModelService(fakeRepo(), AIS);
    expect(await errorCode(service.route('nope', USER))).toBe('model_not_found');
    expect(await errorCode(service.route('later', USER))).toBe('model_unavailable');
  });
});
