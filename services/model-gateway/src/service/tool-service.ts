// 能力网关（ADR 0006）：工具目录，以及每一次工具调用的计量——校验参数 → 冻结额度 → 调供应商 →
// 按实际花费（或估算）结算。属于任务的调用照样发 model-gateway.call.settled，计入任务花费。
import type { ToolEntry, ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import type { Caller, Meter } from './metering.ts';
import { TOOLS, type ToolConfig, type ToolDef } from './tools.ts';

export function createToolService(deps: {
  openrouter: ProviderClient;
  tavily: SearchClient;
  meter: Meter;
  config: ToolConfig;
  logger: Logger;
}) {
  const { meter, config } = deps;
  const byKey = new Map(TOOLS.map((t) => [t.key, t]));
  const configured = (tool: ToolDef) =>
    tool.provider === 'tavily' ? deps.tavily.configured : deps.openrouter.configured;

  /** 这个工具现在能用的模型：去掉当前网络用不了的 */
  async function usableModels(tool: ToolDef): Promise<string[]> {
    const blocked = new Set(await meter.regionBlockedModels());
    return tool.models(config).filter((m) => !blocked.has(m));
  }

  return {
    /** 工具目录：没配 Key、或者没有能用的模型的工具标成不可用 */
    async list(): Promise<ToolEntry[]> {
      const blocked = new Set(await meter.regionBlockedModels());
      return TOOLS.map((tool) => {
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
          available: configured(tool) && (all.length === 0 || models.length > 0),
          models,
          defaultModel: models[0] ?? null,
        };
      });
    },

    async call(input: {
      caller: Caller;
      key: string;
      args: Record<string, unknown>;
      requestId: string;
      signal: AbortSignal;
    }): Promise<ToolResult> {
      const tool = byKey.get(input.key);
      if (!tool) throw new HttpError(404, 'tool_not_found', `没有工具 ${input.key}`);
      if (!configured(tool)) {
        throw new HttpError(503, 'tool_unavailable', `${tool.name}还没有配置好，现在用不了`);
      }
      const parsed = tool.args.safeParse(input.args);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join('.') || '参数'}：${i.message}`,
        );
        throw new HttpError(400, 'invalid_tool_args', `参数不对：${issues.join('；')}`);
      }
      const args = parsed.data;
      if (typeof args.model === 'string' && !tool.models(config).includes(args.model)) {
        throw new HttpError(400, 'invalid_tool_args', `${tool.name}不能用模型 ${args.model}`);
      }
      const models = await usableModels(tool);
      const model = tool.modelOf(args, models);
      if (tool.models(config).length > 0 && !models.includes(model)) {
        throw new HttpError(
          503,
          'provider_region_unavailable',
          `${tool.name}的模型 ${model || ''}在当前网络用不了`,
        );
      }

      const call = await meter.hold({
        caller: input.caller,
        kind: 'tool',
        model,
        amountMicro: tool.holdMicro(args),
        requestId: input.requestId,
      });
      // 供应商已经接下了这次调用（可能已经收费）之后才出的错：按估算结算，不退回
      let accepted = false;
      try {
        const outcome = await tool.run(
          {
            openrouter: deps.openrouter,
            tavily: deps.tavily,
            config,
            signal: input.signal,
            upstream: async (request) => {
              const response = await meter.callUpstream(call, request);
              accepted = true;
              return response;
            },
          },
          args,
          model,
        );
        await meter.settle(call, outcome.cost, undefined);
        return {
          tool: tool.key,
          text: outcome.text,
          ...(outcome.data === undefined ? {} : { data: outcome.data }),
          files: outcome.files,
          costMicro: outcome.cost.costMicro,
        };
      } catch (err) {
        if (accepted) {
          deps.logger.error({ err, tool: tool.key }, '工具结果处理失败');
          await meter.settle(
            call,
            { costMicro: tool.estimateMicro, source: 'estimate' },
            undefined,
            err instanceof Error ? err.message : String(err),
          );
          throw new HttpError(502, 'tool_failed', `${tool.name}返回的结果看不懂`);
        }
        throw err;
      }
    },
  };
}

export type ToolService = ReturnType<typeof createToolService>;
