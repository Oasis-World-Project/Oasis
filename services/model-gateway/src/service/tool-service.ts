// 能力网关（ADR 0006）：工具目录，以及每一次工具调用的计量——校验参数 → 冻结额度 → 调供应商 →
// 按实际花费（或估算）结算。属于任务的调用照样发 model-gateway.call.settled，计入任务花费。
// 长任务（音乐/视频）：提交时冻结并持久化意图，先保存结果再结算；未知结果保留对账状态。
// 这里是目录和组装；调用在 tool-call.ts，长任务在 tool-jobs.ts 和 tool-job-api.ts。
import type { ToolEntry, ToolRate } from '@oasis/contracts/model-gateway';
import type { Typical } from '../repo/calls-repo.ts';
import { videoSecondRate } from './pricing.ts';
import { createToolCall } from './tool-call.ts';
import type { ToolContext, ToolServiceDeps } from './tool-context.ts';
import { createToolJobApi } from './tool-job-api.ts';
import { createToolJobs } from './tool-jobs.ts';
import { TOOLS, type ToolDef } from './tools.ts';

export function createToolService(deps: ToolServiceDeps) {
  const { meter, config } = deps;
  const byKey = new Map(TOOLS.map((t) => [t.key, t]));
  const configured = (tool: ToolDef) =>
    tool.provider === 'harness'
      ? Boolean(deps.harness)
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
        const rate = entry ? videoSecondRate(entry.pricing_skus ?? {}, '720p', false) : NaN;
        if (Number.isFinite(rate) && rate > 0)
          return { model, costMicro: Math.ceil(rate * 1_000_000), seconds, basis: 'catalog' };
      } else if (seen) return { model, costMicro: seen.costMicro, seconds, basis: 'history' };
      return { model, costMicro: tool.estimateMicro, seconds, basis: 'fallback' };
    });
  }

  /** 这个工具现在能用的模型：去掉当前网络用不了的 */
  async function usableModels(tool: ToolDef): Promise<string[]> {
    const blocked = new Set(await meter.regionBlockedModels());
    return tool.models(config).filter((m) => !blocked.has(m));
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
    /** 工具目录：没配 Key、或者没有能用的模型的工具标成不可用 */
    async list(): Promise<ToolEntry[]> {
      const blocked = new Set(await meter.regionBlockedModels());
      const entries = await Promise.all(
        TOOLS.map(async (tool) => {
          const all = tool.models(config);
          const models = all.filter((m) => !blocked.has(m));
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
          };
        }),
      );
      if (deps.avatarCatalog) entries.push(deps.avatarCatalog.entry());
      entries.push({
        key: 'text.batch',
        name: '批量生成文字',
        description:
          '逐行生成文字，可用 --model 选择模型；uses 按输入行数估计，支持停止和恢复。预算/token/超时只在显式传入时生效，实际按 token 计费。',
        usage:
          'oasis-tool text.batch --in 提示.jsonl --out out/结果.jsonl（每行 {"id":"1","prompt":"要求"}；--resume true 恢复）',
        unit: '行',
        estimateMicro: 2_000,
        long: false,
        available: deps.openrouter.configured,
        models: [],
        defaultModel: null,
        rates: [],
      });
      return entries;
    },
    ...createToolCall(ctx),
    start: worker.start,
    close: worker.close,
  };
}

export type ToolService = ReturnType<typeof createToolService>;
