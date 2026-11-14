// 「AI 们」：能聊天的 AI 们和各工具用的型号（都在型号清单 @oasis/contracts/lineup 里），开一轮的路由，
// 以及用户给 AI 们的设置（「只用国内模型」、每个 AI 用哪一档、给它定的名字和人格）。
import type {
  AiProfile,
  AiSettings,
  ModelEntry,
  ModelOption,
  ModelRoute,
  ModelTier,
  SaveAiBody,
} from '@oasis/contracts/agent';
import {
  CHAT_AIS,
  TOOL_LINEUP,
  type ChatAi,
  type ChatOption,
  type ToolLine,
} from '@oasis/contracts/lineup';
import { HttpError } from '@oasis/service-kit';
import type { ModelRepo } from '../repo/model-repo.ts';

/** 这个 AI 现在用的型号：选过的档位；没选过、或那一档已经下架，用第一个（默认） */
function current(ai: ChatAi, tier: ModelTier | undefined): ChatOption | undefined {
  return ai.options.find((option) => option.tier === tier) ?? ai.options[0];
}

/** 对外只给档位、名字、单价和说明，不给上游型号 */
function shown({ tier, label, inputPrice, outputPrice, note }: ChatOption): ModelOption {
  return { tier, label, inputPrice, outputPrice, ...(note ? { note } : {}) };
}

function toEntry(ai: ChatAi, tier: ModelTier | undefined, profile: AiProfile = {}): ModelEntry {
  const option = current(ai, tier);
  return {
    key: ai.key,
    name: ai.name,
    vendor: ai.vendor,
    category: 'llm',
    tags: ai.tags,
    mono: ai.mono,
    glow: ai.glow,
    options: ai.options.map(shown),
    tier: option?.tier ?? null,
    versionLabel: option?.label ?? null,
    available: option !== undefined,
    profile,
  };
}

/** 头像上的字：名字里头两个字母或字（如 Seedream → Se，海螺 → 海螺） */
const monoOf = (name: string) =>
  /^[A-Za-z0-9]/.test(name) ? name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) : name.slice(0, 2);

/** 各工具用的型号（只能看）：同一个型号给几个工具用就写在一起 */
function toolEntries(): ModelEntry[] {
  const entries = new Map<string, ModelEntry>();
  for (const line of Object.values(TOOL_LINEUP) as ToolLine[]) {
    if (!line.category) continue;
    line.models.forEach((model, index) => {
      const usage = index === 0 ? `${line.label}时先用它` : `${line.label}排第 ${index + 1} 个`;
      const seen = entries.get(model.id);
      if (seen) {
        seen.tags = [...new Set([...seen.tags, line.label])];
        seen.usage = `${seen.usage}；${usage}`;
        return;
      }
      entries.set(model.id, {
        key: model.id,
        name: model.name,
        vendor: model.vendor,
        category: line.category!,
        tags: [line.label, ...(model.note ? [model.note] : [])],
        mono: monoOf(model.name),
        glow: '#B9BBC9',
        options: [],
        tier: null,
        versionLabel: null,
        available: false,
        profile: {},
        usage,
      });
    });
  }
  return [...entries.values()];
}

const GENDERS = { male: '男性', female: '女性' } as const;

/**
 * 人设：在 Oasis 里和用户一对一聊天、帮用户把事情做成（平台的做事规则在 harness 给的说明里），
 * 加上用户给它定的名字、性别、人格和要记住的事。
 */
export function systemPrompt(name: string, profile: AiProfile = {}): string {
  const who = profile.name ?? name;
  return [
    `你是 ${who}，正在 Oasis 里和用户一对一聊天，帮用户把事情做成。`,
    '回答自然、简洁，像朋友一样交流。用户用什么语言，你说的每句话都用什么语言，包括做事过程中说明在做什么。',
    '不确定的事情直接说不确定，不要编造。',
    ...(profile.name ? [`用户给你起的名字是「${profile.name}」，问你叫什么就说这个名字。`] : []),
    ...(profile.gender ? [`你的形象是${GENDERS[profile.gender]}。`] : []),
    ...(profile.persona ? ['', '用户给你定的性格和说话方式：', profile.persona] : []),
    ...(profile.notes ? ['', '用户要你记住的：', profile.notes] : []),
  ].join('\n');
}

export function createModelService(repo: ModelRepo, ais: readonly ChatAi[] = CHAT_AIS) {
  function found(key: string): ChatAi {
    const ai = ais.find((item) => item.key === key);
    if (!ai) throw new HttpError(404, 'model_not_found', '没有这个模型');
    return ai;
  }

  return {
    /** 「AI 们」：能聊天的 AI 们（带这个用户选的档位和定的设定），和各工具用的型号 */
    async list(userId: string): Promise<ModelEntry[]> {
      const { tiers, profiles } = await repo.settings(userId);
      return [...ais.map((ai) => toEntry(ai, tiers[ai.key], profiles[ai.key])), ...toolEntries()];
    },

    /** 设置页保存：换档位、定设定；从下一轮起生效，聊天记录照旧 */
    async save(userId: string, key: string, body: SaveAiBody): Promise<ModelEntry> {
      const ai = found(key);
      if (!ai.options.some((option) => option.tier === body.tier))
        throw new HttpError(400, 'tier_not_offered', `${ai.name} 没有这一档`);
      await repo.saveAi(userId, key, body.tier, body.profile);
      return toEntry(ai, body.tier, body.profile);
    },

    /** 开一轮：这个 AI 用哪个型号（这个用户选的档位）、人设，以及这个用户的设置 */
    async route(key: string, userId: string): Promise<ModelRoute> {
      const ai = found(key);
      const { domesticOnly, tiers, profiles } = await repo.settings(userId);
      const option = current(ai, tiers[key]);
      if (!option) throw new HttpError(409, 'model_unavailable', `${ai.name} 还没有接入`);
      const profile = profiles[key] ?? {};
      return {
        key: ai.key,
        name: profile.name ?? ai.name,
        providerModel: option.model,
        systemPrompt: systemPrompt(ai.name, profile),
        domesticOnly,
      };
    },

    async settings(userId: string): Promise<AiSettings> {
      const { domesticOnly } = await repo.settings(userId);
      return { domesticOnly };
    },
    async saveSettings(userId: string, settings: AiSettings): Promise<AiSettings> {
      await repo.saveSettings(userId, settings);
      return settings;
    },
  };
}

export type ModelService = ReturnType<typeof createModelService>;
