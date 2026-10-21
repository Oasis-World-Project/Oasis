// 模型目录与调用路由。人设（名字、人格、声音……）在后续阶段加入，现在用系统默认设定。
import type { ModelEntry, ModelRoute } from '@oasis/contracts/agent';
import { HttpError } from '@oasis/service-kit';
import type { ModelRepo, ModelRow } from '../repo/model-repo.ts';

function toEntry(row: ModelRow): ModelEntry {
  return {
    key: row.key,
    name: row.name,
    vendor: row.vendor,
    category: row.category,
    tags: row.tags,
    mono: row.mono,
    glow: row.glow,
    versionLabel: row.versionLabel,
    available: row.providerModel !== null,
  };
}

/** 系统默认人设：在 Oasis 里和用户一对一聊天。 */
export function defaultSystemPrompt(name: string): string {
  return [
    `你是 ${name}，正在 Oasis 里和用户一对一聊天。`,
    '回答自然、简洁，像朋友一样交流；用户用什么语言，你就用什么语言回答。',
    '不确定的事情直接说不确定，不要编造。',
  ].join('\n');
}

export function createModelService(repo: ModelRepo) {
  return {
    async list(): Promise<ModelEntry[]> {
      return (await repo.list()).map(toEntry);
    },

    async route(key: string): Promise<ModelRoute> {
      const row = await repo.find(key);
      if (!row) throw new HttpError(404, 'model_not_found', '没有这个模型');
      if (!row.providerModel)
        throw new HttpError(409, 'model_unavailable', `${row.name} 还没有接入`);
      return {
        key: row.key,
        name: row.name,
        providerModel: row.providerModel,
        systemPrompt: defaultSystemPrompt(row.name),
      };
    },
  };
}

export type ModelService = ReturnType<typeof createModelService>;
