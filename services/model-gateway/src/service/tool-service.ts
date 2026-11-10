// 能力网关（ADR 0006）：工具目录，以及每一次工具调用的计量——校验参数 → 冻结额度 → 调供应商 →
// 按实际花费（或估算）结算。属于任务的调用照样发 model-gateway.call.settled，计入任务花费。
// 长任务（音乐/视频）：提交时冻结并持久化意图，先保存结果再结算；未知结果保留对账状态。
// 这里是目录和组装；调用在 tool-call.ts，长任务在 tool-jobs.ts 和 tool-job-api.ts。
import type { ToolEntry, ToolRate } from '@oasis/contracts/model-gateway';
import type { Typical } from '../repo/calls-repo.ts';
import type { ModelFilter } from './model-scope.ts';
import { videoCatalogRate } from './pricing.ts';
import { createToolCall } from './tool-call.ts';
import type { ToolContext, ToolServiceDeps } from './tool-context.ts';
import { createToolJobApi } from './tool-job-api.ts';
import { createToolJobs } from './tool-jobs.ts';
import { localOpEntries, textBatchEntry } from './tools/catalog-extras.ts';
import { TOOLS, type ToolDef } from './tools.ts';

export function createToolService(deps: ToolServiceDeps) {
  const { meter, config } = deps;
  const byKey = new Map(TOOLS.map((t) => [t.key, t]));
  const configured = (tool: ToolDef) =>
    tool.provider === 'inspector'
      ? Boolean(deps.checks)
      : tool.provider === 'browserstack'
        ? Boolean(deps.browserstack?.configured)
        : tool.provider === 'runpod'
          ? Boolean(deps.render?.configured)
          : tool.provider === 'tavily'
            ? deps.tavily.configured
            : tool.provider === 'fal'
              ? Boolean(deps.fal?.configured)
              : deps.openrouter.configured;

  /**
   * 每个可用型号的典型单价和用时（ADR 0016 §4）：视频按供应商每秒单价；其余优先用调用记录的
   * 中位数；都没有才用工具目录的兜底值。读不到记录或目录时照样给兜底，不让目录因此不可用。
   */
  async function ratesOf(tool: ToolDef, models: string[]): Promise<ToolRate[]> {
    const typical = deps.estimateFromHistory
      ? await meter
          .typicalUsage()
          .then((u) => u.tools)
          .catch((err: unknown) => {
            deps.logger.warn({ err }, '读不到调用记录，工具估价用兜底值');
            return new Map<string, Typical>();
          })
      : new Map<string, Typical>();
    const videos =
      tool.key === 'video.generate' ? await deps.openrouter.listVideoModels().catch(() => []) : [];
    return models.map((model) => {
      const seen = typical.get(model);
      const seconds = seen?.seconds ?? null;
      if (tool.key === 'video.generate') {
        const entry = videos.find((v) => v.id === model);
        const rate = entry
          ? videoCatalogRate(entry.pricing_skus ?? {}, entry.supported_resolutions ?? [])
          : undefined;
        if (rate) return { model, ...rate, seconds, basis: 'catalog' };
      } else if (seen) return { model, costMicro: seen.costMicro, seconds, basis: 'history' };
      return { model, costMicro: tool.estimateMicro, seconds, basis: 'fallback' };
    });
  }

  /**
   * 这个工具的模型里给不给用：只有经 OpenRouter 调模型的工具按用户的模型范围过滤（ADR 0027），
   * 搜索、云渲染这类不按模型厂商分的工具不过滤。
   */
  const modelsOf = (tool: ToolDef, allowed: ModelFilter) =>
    tool.provider === 'openrouter' ? tool.models(config).filter(allowed) : tool.models(config);

  async function usableModels(tool: ToolDef, payerId: string | undefined): Promise<string[]> {
    return modelsOf(tool, await deps.scope.filterFor(payerId));
  }

  const ctx = {
    deps,
    byKey,
    configured,
    usableModels,
    resultKey: (jobId: string, fileId: string) => `tool-results/${jobId}/${fileId}`,
  } as ToolContext;
  const worker = createToolJobs(ctx);
  Object.assign(ctx, worker);
  const jobApi = createToolJobApi(ctx);
  ctx.ownedJob = jobApi.ownedJob;

  return {
    ...jobApi.api,
    /**
     * 工具目录：没配 Key、或者没有能用的模型的工具标成不可用。payerId 是替哪个用户列的
     * （按他的模型范围过滤型号）；不给就列全部。
     */
    async list(payerId?: string): Promise<ToolEntry[]> {
      const allowed = await deps.scope.filterFor(payerId);
      const entries = await Promise.all(
        TOOLS.map(async (tool) => {
          const models = modelsOf(tool, allowed);
          return {
            key: tool.key,
            name: tool.name,
            description: tool.description,
            usage: tool.usage,
            unit: tool.unit,
            estimateMicro: tool.estimateMicro,
            long: tool.long,
            available: configured(tool) && (tool.provider === 'tavily' || models.length > 0),
            models,
            defaultModel: models[0] ?? null,
            rates: await ratesOf(tool, models),
            args: tool.cli,
            ...(tool.per ? { per: tool.per } : {}),
            local: false,
          };
        }),
      );
      if (deps.avatarCatalog) entries.push(deps.avatarCatalog.entry());
      entries.push(textBatchEntry(deps.openrouter.configured), ...localOpEntries());
      return entries;
    },
    ...createToolCall(ctx),
    start: worker.start,
    close: worker.close,
  };
}

export type ToolService = ReturnType<typeof createToolService>;
