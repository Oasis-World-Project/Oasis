// 模型范围（ADR 0027）：一个用户可以打开「只用国内模型」，之后给他的 AI 团队列出的模型和工具型号
// 都排除国外厂商的；关着（默认）时不排除任何模型。只管经 OpenRouter 调用的模型（厂商/型号）——
// 搜索、云渲染这类不按模型厂商分的工具不受影响。国内厂商的名单在配置里（DOMESTIC_MODEL_VENDORS）。
import type { ModelScope } from '@oasis/contracts/model-gateway';
import type { ModelScopesRepo } from '../repo/model-scopes-repo.ts';

/** 这个模型给不给用 */
export type ModelFilter = (model: string) => boolean;

export function createModelScopeService(deps: {
  repo: ModelScopesRepo;
  /** 国内厂商：模型 ID 里「/」前面的部分，如 deepseek、qwen */
  domesticVendors: string[];
}) {
  const domestic = new Set(deps.domesticVendors);
  const isDomestic: ModelFilter = (model) => domestic.has(model.split('/')[0] ?? '');
  const everything: ModelFilter = () => true;
  return {
    async get(userId: string): Promise<ModelScope> {
      return { domesticOnly: await deps.repo.domesticOnly(userId) };
    },
    async set(userId: string, scope: ModelScope): Promise<ModelScope> {
      await deps.repo.setDomesticOnly(userId, scope.domesticOnly);
      return scope;
    },
    /** 替这个用户挑模型时用的过滤；不知道是替谁（平台自己的调用）就不过滤 */
    async filterFor(userId: string | undefined): Promise<ModelFilter> {
      return userId && (await deps.repo.domesticOnly(userId)) ? isDomestic : everything;
    },
  };
}

export type ModelScopeService = ReturnType<typeof createModelScopeService>;
