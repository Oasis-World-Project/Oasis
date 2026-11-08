// 一次工具调用的计量（ADR 0006）：校验参数 → 冻结额度 → 调供应商 → 按实际花费（或估算）结算。
// 长任务提交时冻结并持久化意图，之后由 tool-jobs 推进；生图、看图在供应商限流或地区不可用时换下一个模型。
import { createHash, randomUUID } from 'node:crypto';
import type { ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import { ToolAdmissionError } from '../repo/tool-jobs-repo.ts';
import { AVATAR_CATALOG_TOOL } from './avatar-catalog.ts';
import { upstreamError, type Caller } from './metering.ts';
import { videoSecondRate } from './pricing.ts';
import { HOLD_MARGIN_MS, type ToolContext } from './tool-context.ts';
import type { ToolDef } from './tools.ts';

export function createToolCall(ctx: ToolContext) {
  const { deps, byKey, configured } = ctx;
  const { meter, config, jobs } = deps;
  const usableModels = (tool: ToolDef) => ctx.usableModels(tool);
  const ownedJob = (caller: Caller, id: string) => ctx.ownedJob(caller, id);

  return {
    async call(input: {
      caller: Caller;
      key: string;
      args: Record<string, unknown>;
      requestId: string;
      signal: AbortSignal;
      maxCostMicro?: number;
      idempotencyKey?: string;
    }): Promise<ToolResult> {
      if (input.caller.taskId && (await jobs.taskDeleted(input.caller.taskId)))
        throw new HttpError(410, 'tool_result_deleted', '所属任务已删除');
      if (input.key === AVATAR_CATALOG_TOOL && deps.avatarCatalog) {
        return deps.avatarCatalog.run(input.args);
      }
      const tool = byKey.get(input.key);
      if (!tool) throw new HttpError(404, 'tool_not_found', `没有工具 ${input.key}`);
      const parsed = tool.args.safeParse(input.args);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join('.') || '参数'}：${i.message}`,
        );
        throw new HttpError(400, 'invalid_tool_args', `参数不对：${issues.join('；')}`);
      }
      const args = parsed.data;
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ key: tool.key, args }))
        .digest('hex');
      const resume = async (id: string): Promise<ToolResult> => {
        const prior = await ownedJob(input.caller, id);
        if (prior.requestHash !== requestHash || prior.tool !== tool.key)
          throw new HttpError(409, 'tool_request_conflict', '同一请求号的工具参数不一致');
        return {
          tool: tool.key,
          text: `沿用已提交的任务号 ${id}，未重新调用供应商。`,
          files: [],
          costMicro: 0,
          job: { id },
        };
      };
      if (tool.long && input.idempotencyKey) {
        const prior = await jobs.byRequest(input.idempotencyKey);
        if (prior) return resume(prior.id);
      }
      if (!configured(tool) || (tool.provider !== 'tavily' && !tool.models(config).length)) {
        throw new HttpError(503, 'tool_unavailable', `${tool.name}还没有配置好，现在用不了`);
      }

      if (typeof args.model === 'string' && !tool.models(config).includes(args.model)) {
        throw new HttpError(400, 'invalid_tool_args', `${tool.name}不能用模型 ${args.model}`);
      }
      let models = await usableModels(tool);
      let videoHoldMicro: number | undefined;
      let videoEstimateMicro: number | undefined;
      if (tool.key === 'video.generate') {
        const catalogue = await deps.openrouter.listVideoModels().catch(() => []);
        const compatible = catalogue.filter(
          (entry) =>
            models.includes(entry.id) &&
            entry.supported_durations?.includes(Number(args.duration)) &&
            entry.supported_resolutions?.includes(String(args.resolution)) &&
            (!args.aspect_ratio ||
              entry.supported_aspect_ratios?.includes(String(args.aspect_ratio))) &&
            (!args.first_frame || entry.supported_frame_images?.includes('first_frame')),
        );
        models = models.filter((model) => compatible.some((entry) => entry.id === model));
        const selected = compatible.find((entry) => entry.id === tool.modelOf(args, models));
        const rate = videoSecondRate(
          selected?.pricing_skus ?? {},
          String(args.resolution),
          Boolean(args.first_frame),
        );
        const referenceCost = args.first_frame
          ? Number(selected?.pricing_skus?.cents_per_image_input ?? 0)
          : 0;
        if (
          !selected ||
          !Number.isFinite(rate) ||
          rate <= 0 ||
          !Number.isFinite(referenceCost) ||
          referenceCost < 0
        )
          throw new HttpError(
            400,
            'video_parameters_unsupported',
            '无法确认视频模型支持所选参数/首帧及价格；未提交供应商',
          );
        videoEstimateMicro = Math.ceil(
          (rate * Number(args.duration) + referenceCost / 100) * 1_000_000,
        );
        videoHoldMicro = Math.max(tool.holdMicro(args), videoEstimateMicro);
      }
      if (tool.key === 'image.generate' && Array.isArray(args.references)) {
        const count = args.references.length;
        const compatible: string[] = [];
        for (const candidate of models) {
          const limit = await deps.openrouter.imageReferenceLimit(candidate).catch(() => 0);
          if (limit >= count) compatible.push(candidate);
        }
        models = compatible;
        if (!models.length || (typeof args.model === 'string' && !models.includes(args.model))) {
          throw new HttpError(
            400,
            'reference_images_unsupported',
            '没有已确认支持此参考图数量的可用模型；未调用生图',
          );
        }
      }
      const model = tool.modelOf(args, models);
      if (tool.models(config).length > 0 && !models.includes(model)) {
        throw new HttpError(
          503,
          'provider_region_unavailable',
          `${tool.name}的模型 ${model || ''}在当前网络用不了`,
        );
      }

      const canFallback = tool.key === 'image.generate' || tool.key === 'image.inspect';
      const candidates =
        !canFallback || typeof args.model === 'string' || !models.length ? [model] : models;
      let lastError: unknown;
      for (const model of candidates) {
        const call = await meter.hold({
          caller: input.caller,
          kind: tool.provider === 'runpod' ? 'compute' : 'tool',
          model,
          amountMicro:
            tool.provider === 'runpod'
              ? deps.render!.holdMicro
              : (videoHoldMicro ?? tool.holdMicro(args)),
          ...(input.maxCostMicro === undefined ? {} : { maxCostMicro: input.maxCostMicro }),
          requestId: input.requestId,
          ...(tool.long ? { ttlMs: deps.jobTimeoutMs + HOLD_MARGIN_MS } : {}),
        });
        // 供应商已经接下了这次调用（可能已经收费）之后才出的错：按估算结算，不退回
        let accepted = false;
        const toolDeps = {
          harness: deps.harness,
          taskId: input.caller.taskId,
          runId: input.caller.runId,
          browserstack: deps.browserstack,
          payerId: input.caller.payerId,
          openrouter: deps.openrouter,
          tavily: deps.tavily,
          fal: deps.fal,
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
            const id = randomUUID();
            if (
              !(await jobs
                .insert({
                  id,
                  tool: tool.key,
                  providerJobId: '',
                  call: {
                    ...call,
                    ...(tool.provider === 'runpod'
                      ? { inputArgs: args, holdCeiling: deps.render!.holdMicro }
                      : {}),
                    ...(videoEstimateMicro === undefined ? {} : { videoEstimateMicro }),
                  },
                  requestKey: input.idempotencyKey ?? null,
                  requestHash,
                })
                .catch(async (error: unknown) => {
                  await meter.fail(call, '作业准入失败，未调用供应商');
                  if (error instanceof ToolAdmissionError)
                    throw new HttpError(
                      503,
                      'render_profile_busy',
                      '云渲染仍有在途或待对账作业，请稍后重试',
                    );
                  throw error;
                }))
            ) {
              await meter.fail(call, '重复工具请求，未提交供应商');
              const prior = input.idempotencyKey
                ? await jobs.byRequest(input.idempotencyKey)
                : undefined;
              if (!prior) throw new Error('重复工具请求无法恢复');
              return resume(prior.id);
            }
            if (tool.deferred) {
              await jobs.update(id, { phase: 'uploading' });
              return {
                tool: tool.key,
                text: '输入准备中；上传全部资产后提交同一作业。',
                files: [],
                costMicro: 0,
                job: { id },
              };
            }
            try {
              const providerJobId = await tool.start(
                {
                  ...toolDeps,
                  signal: AbortSignal.any([
                    input.signal,
                    AbortSignal.timeout(deps.submitTimeoutMs ?? 60_000),
                  ]),
                  upstream: async (request) => {
                    // POST 断连无法判断供应商是否接受，不释放冻结或自动重发。
                    const response = await request();
                    if (response.status >= 500) {
                      await response.body?.cancel();
                      throw new Error('供应商服务器响应未确认');
                    }
                    if (!response.ok) {
                      const detail = (await response.text().catch(() => '')).slice(0, 500);
                      await meter.fail(call, `供应商拒绝：${response.status} ${detail}`);
                      await jobs.finish(id, 'failed', '供应商拒绝了提交');
                      // 平台额度用完这类原因照实说（2026-11-06：视频提交被 Key 上限拒绝，只显示「拒绝了提交」）
                      const known = upstreamError(response.status, detail);
                      throw known.code === 'provider_error'
                        ? new HttpError(502, 'provider_error', '供应商拒绝了提交')
                        : known;
                    }
                    accepted = true;
                    return response;
                  },
                },
                args,
                model,
              );
              await jobs.update(id, { providerJobId, phase: 'pending' });
            } catch (error) {
              if (tool.provider === 'browserstack') {
                // 此阶段仅上传 APK，尚未创建任何设备会话；失败不会产生设备运行费用。
                await meter.fail(call, 'APK 上传未完成，未启动设备');
                await jobs.finish(id, 'failed', 'APK 上传未完成，未启动设备');
                throw error;
              }
              const row = await jobs.get(id);
              if (row?.status !== 'failed')
                await jobs.update(id, {
                  phase: 'uncertain',
                  error: '供应商提交结果未确认，未自动重发',
                });
              deps.logger.warn({ jobId: id }, '供应商长任务提交未确认');
              if (row?.status === 'failed') throw error;
            }
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
            if (err instanceof HttpError) throw err;
            throw new HttpError(502, 'tool_failed', `${tool.name}返回的结果看不懂`);
          }
          // 上游拒绝时冻结已退回、没有收费：地区用不了或被限流（共享额度上常见）就换列表里的下一个模型
          if (
            err instanceof HttpError &&
            (err.code === 'provider_region_unavailable' || err.code === 'provider_busy') &&
            typeof args.model !== 'string'
          ) {
            lastError = err;
            continue;
          }
          throw err;
        }
      }
      throw lastError;
    },
  };
}

function resultOf(
  tool: ToolDef,
  outcome: {
    text: string;
    data?: unknown;
    files: { name: string; mediaType: string; base64?: string }[];
    cost: { costMicro: number };
  },
): ToolResult {
  return {
    tool: tool.key,
    text: outcome.text,
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    files: outcome.files.map((file) => ({
      name: file.name,
      mediaType: file.mediaType,
      base64: file.base64 ?? '',
    })),
    costMicro: outcome.cost.costMicro,
  };
}
