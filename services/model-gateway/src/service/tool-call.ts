// 一次工具调用的计量：校验参数 → 冻结额度 → 调供应商 → 按实际花费（或估算）结算。
// 长任务提交时冻结并持久化意图，之后由 tool-jobs 推进；生图、看图在供应商限流或地区不可用时换下一个模型。
import { createHash, randomUUID } from 'node:crypto';
import { GENERATION_TOOLS, type ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import { ToolAdmissionError } from '../repo/tool-jobs-repo.ts';
import { AVATAR_CATALOG_TOOL } from './avatar-catalog.ts';
import { upstreamError, type Caller } from './metering.ts';
import { videoSecondRate } from './pricing.ts';
import { HOLD_MARGIN_MS, type ToolContext } from './tool-context.ts';
import type { ToolDef } from './tools.ts';
import { mediaKinds } from './tools/images.ts';
import { needsModel } from './tools/kit.ts';
import { videoProblems, videoRejection } from './tools/video.ts';
import { isWebTool } from './tools/web.ts';

/** 要做一阵子的生成：每个人同时最多做几个（一次 image.generate 算一个；2026-11-14 第 3 阶段） */
const GENERATIONS = ['image.generate', 'video.generate', 'audio.music', '3d.generate'];
const MAX_RUNNING_GENERATIONS = 4;

export function createToolCall(ctx: ToolContext) {
  const { deps, byKey, configured } = ctx;
  const { meter, config, jobs } = deps;
  const ownedJob = (caller: Caller, id: string) => ctx.ownedJob(caller, id);

  /** 同时在做的生成到了上限就不接，说清楚在做的是哪些；没做完的长任务冻结着，最久算到它的冻结期 */
  async function admitGeneration(payerId: string): Promise<void> {
    const since = new Date(Date.now() - deps.jobTimeoutMs - HOLD_MARGIN_MS);
    const running = await meter.runningTools(payerId, GENERATIONS, since);
    const total = [...running.values()].reduce((sum, n) => sum + n, 0);
    if (total < MAX_RUNNING_GENERATIONS) return;
    const doing = [...running].map(([key, n]) => `${byKey.get(key)?.name ?? key} ${n} 个`);
    throw new HttpError(
      429,
      'too_many_running',
      `同时在做的生成已经有 ${total} 个（${doing.join('、')}），最多 ${MAX_RUNNING_GENERATIONS} 个；等前面的做完（oasis-tool wait 它们的任务号）再交这个，这次没有提交、没有收费`,
    );
  }

  return {
    async call(input: {
      caller: Caller;
      key: string;
      args: Record<string, unknown>;
      requestId: string;
      signal: AbortSignal;
      maxCostMicro?: number;
      idempotencyKey?: string;
      /** 用户允许过的花钱工具确认卡 */
      confirmationId?: string;
    }): Promise<ToolResult> {
      const { conversationId } = input.caller;
      if (conversationId && (await jobs.conversationDeleted(conversationId)))
        throw new HttpError(410, 'tool_result_deleted', '所属对话已删除');
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
      // 用户关了这段对话的联网搜索：先说这个原因（比「没配置好」更该让 AI 知道）
      if (input.caller.noWeb && isWebTool(tool.key))
        throw new HttpError(
          403,
          'web_off',
          '用户关了这段对话的联网搜索，现在不能搜索和读网页；需要的话请用户在输入框里打开',
        );
      if (!configured(tool) || (needsModel(tool) && !tool.models(config).length)) {
        throw new HttpError(503, 'tool_unavailable', `${tool.name}还没有配置好，现在用不了`);
      }
      if (GENERATIONS.includes(tool.key)) await admitGeneration(input.caller.payerId);

      if (typeof args.model === 'string' && !tool.models(config).includes(args.model)) {
        throw new HttpError(400, 'invalid_tool_args', `${tool.name}不能用模型 ${args.model}`);
      }
      let models = ctx.usableModels(tool, input.caller.domesticOnly);
      let videoHoldMicro: number | undefined;
      let videoEstimateMicro: number | undefined;
      if (tool.key === 'video.generate') {
        const catalogue = await deps.openrouter.listVideoModels().catch(() => []);
        const usable = models;
        const compatible = catalogue.filter(
          (entry) => usable.includes(entry.id) && !videoProblems(entry, args).length,
        );
        models = usable.filter((model) => compatible.some((entry) => entry.id === model));
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
            videoRejection({
              catalogue,
              usable,
              fitting: models,
              args,
              ...(selected ? { unpriced: selected.id } : {}),
            }),
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
      if (tool.key === 'media.inspect') {
        // 只留读得了这次全部文件的型号：图片、视频、音频各有各的型号，目录说了算
        const kinds = mediaKinds(args);
        // 目录还没拉到（刚启动、供应商目录暂时读不了）时不筛，照配置的先后试
        const listed = models.some((candidate) => deps.inputsOf(candidate) !== undefined);
        const able = models.filter((candidate) => {
          const inputs = deps.inputsOf(candidate);
          return !listed || (inputs !== undefined && kinds.every((kind) => inputs.includes(kind)));
        });
        if (models.length && !able.length)
          throw new HttpError(
            400,
            'media_unsupported',
            `可用的型号里没有读得了${kinds.join('、')}的；没有调用`,
          );
        if (
          typeof args.model === 'string' &&
          models.includes(args.model) &&
          !able.includes(args.model)
        )
          throw new HttpError(
            400,
            'media_unsupported',
            `${args.model} 读不了${kinds.join('、')}；可以用：${able.join('、')}`,
          );
        models = able;
      }
      const model = tool.modelOf(args, models);
      // 配了模型却一个也不给用，或点名的模型不在给用的里面：这个用户开着「只用国内模型」
      if (tool.models(config).length > 0 && !models.includes(model)) {
        throw new HttpError(
          409,
          'model_out_of_scope',
          `已开启「只用国内模型」，${tool.name}${model ? `不能用 ${model}` : '没有国内型号可用'}${models.length ? `；可以用：${models.join('、')}` : ''}`,
        );
      }

      const holdMicro =
        tool.provider === 'runpod'
          ? deps.render!.holdMicro
          : (videoHoldMicro ?? tool.holdMicro(args));
      // 用户设了花钱的工具「问我」：先登记确认卡、不调，等用户允许后 oasis-tool 带确认号重交
      if (GENERATION_TOOLS.includes(tool.key) && deps.confirmations) {
        const waiting = await deps.confirmations.paidTool(
          input.caller,
          `${tool.name}（${model}），最多 $${(holdMicro / 1_000_000).toFixed(2)}`,
          input.confirmationId,
        );
        if (waiting)
          return {
            tool: tool.key,
            text: '要先等用户在聊天里确认；还没调用、没花钱',
            files: [],
            costMicro: 0,
            confirmation: waiting,
          };
      }

      const canFallback = tool.key === 'image.generate' || tool.key === 'media.inspect';
      const candidates =
        !canFallback || typeof args.model === 'string' || !models.length ? [model] : models;
      let lastError: unknown;
      for (const model of candidates) {
        const call = await meter.hold({
          caller: input.caller,
          kind: tool.provider === 'runpod' ? 'compute' : 'tool',
          model,
          tool: tool.key,
          amountMicro: holdMicro,
          ...(input.maxCostMicro === undefined ? {} : { maxCostMicro: input.maxCostMicro }),
          requestId: input.requestId,
          ...(tool.long ? { ttlMs: deps.jobTimeoutMs + HOLD_MARGIN_MS } : {}),
        });
        // 供应商已经接下了这次调用（可能已经收费）之后才出的错：按估算结算，不退回
        let accepted = false;
        const toolDeps = {
          checks: deps.checks,
          runId: input.caller.runId,
          conversationId,
          logger: deps.logger,
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
