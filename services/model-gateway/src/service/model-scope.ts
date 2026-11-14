// 模型范围：用户在 AI 们里打开「只用国内模型」后（设置存在 agent，开一轮时随临时 Key 带来），
// 这一轮的执行模型和各工具的型号都排除国外厂商的；关着（默认）时不排除任何模型。只管经 OpenRouter
// 调用的模型（厂商/型号）——搜索、云渲染这类不按模型厂商分的工具不受影响。
// 国内厂商的名单在配置里（DOMESTIC_MODEL_VENDORS）。

/** 这个模型给不给用 */
export type ModelFilter = (model: string) => boolean;

export function createModelScope(deps: {
  /** 国内厂商：模型 ID 里「/」前面的部分，如 deepseek、qwen */
  domesticVendors: string[];
}) {
  const domestic = new Set(deps.domesticVendors);
  const isDomestic: ModelFilter = (model) => domestic.has(model.split('/')[0] ?? '');
  const everything: ModelFilter = () => true;
  return {
    /** 打开「只用国内模型」时只留国内厂商的型号 */
    filterFor: (domesticOnly: boolean | undefined): ModelFilter =>
      domesticOnly ? isDomestic : everything,
  };
}

export type ModelScope = ReturnType<typeof createModelScope>;
