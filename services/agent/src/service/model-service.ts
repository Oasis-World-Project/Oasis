// 模型目录、开一轮的路由，以及用户给 AI 们的设置（「只用国内模型」、每个 AI 用哪一档）。
// 人设（名字、人格、声音……）以后再加，现在用系统默认设定。
import type {
  AiSettings,
  ModelEntry,
  ModelOption,
  ModelRoute,
  ModelTier,
} from '@oasis/contracts/agent';
import { HttpError } from '@oasis/service-kit';
import type { ModelRepo, ModelRow } from '../repo/model-repo.ts';
import type { StoredOption } from '../repo/schema.ts';

/** 这个 AI 现在用的型号：选过的档位；没选过、或那一档已经下架，用第一个（默认） */
function current(row: ModelRow, tier: ModelTier | undefined): StoredOption | undefined {
  return row.options.find((option) => option.tier === tier) ?? row.options[0];
}

/** 对外只给档位、名字、单价和说明，不给上游型号 */
function shown({ tier, label, inputPrice, outputPrice, note }: StoredOption): ModelOption {
  return { tier, label, inputPrice, outputPrice, ...(note ? { note } : {}) };
}

function toEntry(row: ModelRow, tier: ModelTier | undefined): ModelEntry {
  const option = current(row, tier);
  return {
    key: row.key,
    name: row.name,
    vendor: row.vendor,
    category: row.category,
    tags: row.tags,
    mono: row.mono,
    glow: row.glow,
    options: row.options.map(shown),
    tier: option?.tier ?? null,
    versionLabel: option?.label ?? null,
    available: option !== undefined,
  };
}

/** 系统默认人设：在 Oasis 里和用户一对一聊天、帮用户把事情做成（平台的做事规则在 harness 给的说明里）。 */
export function defaultSystemPrompt(name: string): string {
  return [
    `你是 ${name}，正在 Oasis 里和用户一对一聊天，帮用户把事情做成。`,
    '回答自然、简洁，像朋友一样交流。用户用什么语言，你说的每句话都用什么语言，包括做事过程中说明在做什么。',
    '不确定的事情直接说不确定，不要编造。',
  ].join('\n');
}

export function createModelService(repo: ModelRepo) {
  async function found(key: string): Promise<ModelRow> {
    const row = await repo.find(key);
    if (!row) throw new HttpError(404, 'model_not_found', '没有这个模型');
    return row;
  }

  return {
    /** 模型目录，带这个用户给每个 AI 选的档位 */
    async list(userId: string): Promise<ModelEntry[]> {
      const [rows, { tiers }] = await Promise.all([repo.list(), repo.settings(userId)]);
      return rows.map((row) => toEntry(row, tiers[row.key]));
    },

    /** 给一个 AI 换档位；从下一轮起用新型号，聊天记录照旧 */
    async chooseTier(userId: string, key: string, tier: ModelTier): Promise<ModelEntry> {
      const row = await found(key);
      if (!row.options.some((option) => option.tier === tier))
        throw new HttpError(400, 'tier_not_offered', `${row.name} 没有这一档`);
      await repo.saveTier(userId, key, tier);
      return toEntry(row, tier);
    },

    /** 开一轮：这个 AI 用哪个型号（这个用户选的档位）、人设，以及这个用户的设置 */
    async route(key: string, userId: string): Promise<ModelRoute> {
      const row = await found(key);
      const { domesticOnly, tiers } = await repo.settings(userId);
      const option = current(row, tiers[key]);
      if (!option) throw new HttpError(409, 'model_unavailable', `${row.name} 还没有接入`);
      return {
        key: row.key,
        name: row.name,
        providerModel: option.model,
        systemPrompt: defaultSystemPrompt(row.name),
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
