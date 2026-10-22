// 能力网关（ADR 0006）：工具目录，以及每一次工具调用的计量——校验参数 → 冻结额度 → 调供应商 →
// 按实际花费（或估算）结算。属于任务的调用照样发 model-gateway.call.settled，计入任务花费。
// 长任务（视频）：提交时冻结并记下供应商的任务号，调用方之后来取结果，做好时结算、失败或超时退回。
import { randomUUID } from 'node:crypto';
import type { ToolEntry, ToolJobBody, ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import type { ToolJobsRepo } from '../repo/tool-jobs-repo.ts';
import type { Caller, Meter, MeteredCall } from './metering.ts';
import { TOOLS, type ToolConfig, type ToolDef } from './tools.ts';

/** 长任务的冻结比等待上限多留这么久，免得结算前就被自动退回 */
const HOLD_MARGIN_MS = 10 * 60_000;

export function createToolService(deps: {
  openrouter: ProviderClient;
  tavily: SearchClient;
  meter: Meter;
  jobs: ToolJobsRepo;
  /** 长任务最多等多久 */
  jobTimeoutMs: number;
  config: ToolConfig;
  logger: Logger;
}) {
  const { meter, config, jobs } = deps;
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
        ...(tool.long ? { ttlMs: deps.jobTimeoutMs + HOLD_MARGIN_MS } : {}),
      });
      // 供应商已经接下了这次调用（可能已经收费）之后才出的错：按估算结算，不退回
      let accepted = false;
      const toolDeps = {
        openrouter: deps.openrouter,
        tavily: deps.tavily,
        config,
        signal: input.signal,
        upstream: async (request: () => Promise<Response>) => {
          const response = await meter.callUpstream(call, request);
          accepted = true;
          return response;
        },
      };
      try {
        if (tool.long) {
          const providerJobId = await tool.start(toolDeps, args, model);
          const id = randomUUID();
          await jobs.insert({ id, tool: tool.key, providerJobId, call: { ...call } });
          return {
            tool: tool.key,
            text: `${tool.name}已提交，要等几分钟；任务号 ${id}。`,
            files: [],
            costMicro: 0,
            job: { id },
          };
        }
        const outcome = await tool.run(toolDeps, args, model);
        await meter.settle(call, outcome.cost, undefined);
        return resultOf(tool, outcome);
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

    /**
     * 长任务的进度。做好了就结算并交回结果；供应商说失败或等太久就退回冻结。
     * 多个请求同时来取时，只有把记录从 pending 改掉的那一个结算。
     */
    async job(caller: Caller, jobId: string, signal: AbortSignal): Promise<ToolJobBody> {
      const job = await jobs.get(jobId);
      const call = job?.call as MeteredCall | undefined;
      if (!job || !call || call.caller.payerId !== caller.payerId) {
        throw new HttpError(404, 'tool_job_not_found', `没有任务号 ${jobId}`);
      }
      const tool = byKey.get(job.tool);
      if (!tool?.long) throw new HttpError(404, 'tool_job_not_found', `没有任务号 ${jobId}`);
      if (job.status === 'failed') return { status: 'failed', error: job.error ?? '没做出来' };

      const toolDeps = {
        openrouter: deps.openrouter,
        tavily: deps.tavily,
        config,
        signal,
        upstream: (request: () => Promise<Response>) => request(),
      };
      const timedOut = Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs;
      let state;
      try {
        state = await tool.check(toolDeps, job.providerJobId);
      } catch (err) {
        deps.logger.warn({ err, jobId }, '查长任务进度失败');
        if (job.status === 'completed') {
          throw new HttpError(503, 'provider_unavailable', '结果暂时取不回来，请稍后再试');
        }
        state = { state: 'pending' as const };
      }
      if (state.state === 'completed') {
        if (await jobs.finish(jobId, 'completed')) {
          await meter.settle(call, state.outcome.cost, undefined);
        }
        return {
          status: 'completed',
          result: { ...resultOf(tool, state.outcome), job: { id: jobId } },
        };
      }
      if (job.status === 'completed') {
        throw new HttpError(503, 'provider_unavailable', '结果暂时取不回来，请稍后再试');
      }
      const error =
        state.state === 'failed'
          ? state.error
          : timedOut
            ? `等了 ${Math.round(deps.jobTimeoutMs / 60_000)} 分钟还没做好，已放弃`
            : undefined;
      if (!error) return { status: 'pending' };
      if (await jobs.finish(jobId, 'failed', error)) await meter.fail(call, error);
      return { status: 'failed', error };
    },
  };
}

function resultOf(
  tool: ToolDef,
  outcome: {
    text: string;
    data?: unknown;
    files: ToolResult['files'];
    cost: { costMicro: number };
  },
): ToolResult {
  return {
    tool: tool.key,
    text: outcome.text,
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    files: outcome.files,
    costMicro: outcome.cost.costMicro,
  };
}

export type ToolService = ReturnType<typeof createToolService>;
