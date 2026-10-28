// 能力网关（ADR 0006）：工具目录，以及每一次工具调用的计量——校验参数 → 冻结额度 → 调供应商 →
// 按实际花费（或估算）结算。属于任务的调用照样发 model-gateway.call.settled，计入任务花费。
// 长任务（音乐/视频）：提交时冻结并持久化意图，先保存结果再结算；未知结果保留对账状态。
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import type { ToolEntry, ToolJobBody, ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ObjectStore } from '@oasis/service-kit';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { FalClient } from '../adapters/fal.ts';
import { RenderArgs, type RenderClient } from '../adapters/runpod.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import { ToolAdmissionError, type ToolJobsRepo } from '../repo/tool-jobs-repo.ts';
import type { Caller, Meter, MeteredCall } from './metering.ts';
import { TOOLS, type ToolConfig, type ToolDef } from './tools.ts';

/** 长任务的冻结比等待上限多留这么久，免得结算前就被自动退回 */
const HOLD_MARGIN_MS = 10 * 60_000;

export function createToolService(deps: {
  openrouter: ProviderClient;
  tavily: SearchClient;
  meter: Meter;
  jobs: ToolJobsRepo;
  store: ObjectStore;
  fal?: FalClient;
  render?: RenderClient;
  resultMaxBytes?: number;
  retentionMs?: number;
  submitTimeoutMs?: number;
  /** 长任务最多等多久 */
  jobTimeoutMs: number;
  config: ToolConfig;
  logger: Logger;
}) {
  const { meter, config, jobs } = deps;
  const byKey = new Map(TOOLS.map((t) => [t.key, t]));
  const configured = (tool: ToolDef) =>
    tool.provider === 'runpod'
      ? Boolean(deps.render?.configured)
      : tool.provider === 'tavily'
        ? deps.tavily.configured
        : tool.provider === 'fal'
          ? Boolean(deps.fal?.configured)
          : deps.openrouter.configured;

  /** 这个工具现在能用的模型：去掉当前网络用不了的 */
  async function usableModels(tool: ToolDef): Promise<string[]> {
    const blocked = new Set(await meter.regionBlockedModels());
    return tool.models(config).filter((m) => !blocked.has(m));
  }

  const resultKey = (jobId: string, fileId: string) => `tool-results/${jobId}/${fileId}`;
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  async function processOne(id: string) {
    const prior = inFlight.get(id);
    if (prior) return prior;
    const work = (async () => {
      const token = randomUUID();
      if (!(await jobs.claim(id, token, new Date(Date.now() + 180_000)))) return;
      let lostLease = false;
      const heartbeat = setInterval(() => {
        void jobs
          .claim(id, token, new Date(Date.now() + 180_000))
          .then((owned) => {
            if (!owned) lostLease = true;
          })
          .catch((err: unknown) => deps.logger.warn({ err, jobId: id }, '媒体任务租约续期失败'));
      }, 30_000);
      heartbeat.unref();
      try {
        const job = await jobs.get(id);
        if (job?.tool === '3d.render' && job.status === 'pending' && !job.cost) {
          try {
            await meter.renew(job.call as unknown as MeteredCall);
          } catch {
            await jobs.requestCancel(id);
            if (job.providerJobId)
              await deps.render?.cancel(job.providerJobId).catch(() => undefined);
            await jobs.update(id, {
              phase: 'uncertain',
              error: '冻结无法续期；已请求止损，后续费用保留平台风险',
            });
            return;
          }
        }
        if (
          !job ||
          job.phase === 'expired' ||
          (job.phase === 'uncertain' && job.call.cancelRequested !== true) ||
          job.status === 'failed' ||
          (job.status === 'completed' && job.result)
        )
          return;
        if (
          job.tool === '3d.render' &&
          !job.call.submissionAttempted &&
          (job.phase === 'uploading' || job.call.cancelRequested)
        ) {
          if (
            job.call.cancelRequested ||
            Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs
          ) {
            await deps.render?.cleanup(
              id,
              (job.call.inputArgs as { assets: unknown[] }).assets.length,
            );
            await meter.fail(job.call as unknown as MeteredCall, '上传取消或过期，未提交 GPU');
            await jobs.finish(id, 'failed', '未提交 GPU');
          }
          return;
        }
        const call = job.call as unknown as MeteredCall;
        if (job.call.terminalAudit && job.cost) {
          if (!(await meter.settle(call, job.cost, undefined, 'GPU 终态费用已核对'))) return;
          await deps.render?.cleanup(
            id,
            (job.call.inputArgs as { assets: unknown[] }).assets.length,
          );
          await jobs.finish(id, 'failed', 'GPU 已终止，费用已核对');
          return;
        }
        if (!job.providerJobId) {
          if (job.phase === 'submitting' && Date.now() - job.createdAt.getTime() < 120_000) return;
          await jobs.update(id, {
            phase: 'uncertain',
            error: '提交结果未确认；未自动重发，请核对供应商账单',
          });
          return;
        }
        let result = job.result;
        let cost = job.cost;
        if (!result) {
          const tool = byKey.get(job.tool);
          if (!tool?.long) throw new Error('长任务工具不存在');
          const toolDeps = {
            openrouter: deps.openrouter,
            tavily: deps.tavily,
            fal: deps.fal,
            render: deps.render,
            config,
            signal: AbortSignal.timeout(120_000),
            upstream: (request: () => Promise<Response>) => request(),
          };
          if (job.call.cancelRequested === true) {
            if (!tool.cancel) {
              await jobs.update(id, {
                phase: 'uncertain',
                error: '供应商取消接口尚未接入，费用及终态待核对',
              });
              return;
            }
            try {
              await tool.cancel(toolDeps, job.providerJobId);
            } catch {
              if (Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs)
                await jobs.update(id, {
                  phase: 'uncertain',
                  error: '取消长期未确认；费用和供应商状态待人工核对',
                });
              return;
            }
          }
          const state = await tool
            .check(
              {
                openrouter: deps.openrouter,
                tavily: deps.tavily,
                fal: deps.fal,
                render: deps.render,
                config,
                signal: AbortSignal.timeout(120_000),
                upstream: (request) => request(),
              },
              job.providerJobId,
            )
            .catch(async (error: unknown) => {
              if (Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs) {
                await jobs.update(id, {
                  phase: 'uncertain',
                  error: '供应商结果无法取回，费用与文件待核对；未重新生成',
                });
                return { state: 'pending' as const };
              }
              throw error;
            });
          if (state.state === 'failed') {
            if (job.call.cancelRequested === true) {
              await jobs.update(id, {
                phase: 'uncertain',
                error: '供应商终止，费用未确认；未自动退回',
              });
              return;
            }
            await meter.fail(call, state.error);
            await jobs.finish(id, 'failed', state.error);
            return;
          }
          if (state.state === 'uncertain') {
            await jobs.update(id, { phase: 'uncertain', error: state.error });
            return;
          }
          if (state.state === 'pending') {
            if (Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs)
              await jobs.update(id, {
                phase: 'uncertain',
                error: '供应商长任务超过等待上限，费用待核对；未自动重发或认定免费',
              });
            return;
          }
          cost = state.outcome.cost;
          const quoted = Number(job.call.videoEstimateMicro);
          if (
            job.tool === 'video.generate' &&
            cost?.source === 'estimate' &&
            Number.isSafeInteger(quoted) &&
            quoted > 0
          )
            cost = { costMicro: quoted, source: 'estimate' };
          const files: ToolResult['files'] = [];
          for (const [index, file] of state.outcome.files.entries()) {
            const fileId = String(index);
            const source = file.body ?? Readable.from([Buffer.from(file.base64 ?? '', 'base64')]);
            const saved = await deps.store.putStream(
              resultKey(id, fileId),
              source,
              file.mediaType,
              {
                maxBytes: deps.resultMaxBytes ?? 512 * 1024 * 1024,
                ...(file.size === undefined ? {} : { size: file.size }),
                ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
              },
            );
            files.push({
              id: fileId,
              name: file.name,
              mediaType: file.mediaType,
              base64: '',
              ...saved,
            });
          }
          result = {
            tool: tool.key,
            text: state.outcome.text,
            ...(state.outcome.data === undefined ? {} : { data: state.outcome.data }),
            files,
            costMicro: cost?.costMicro ?? 0,
            job: { id },
          };
          await jobs.update(id, {
            result,
            cost,
            phase: 'stored',
            expiresAt: new Date(Date.now() + (deps.retentionMs ?? 7 * 24 * 3600_000)),
          });
        }
        if (!cost) {
          await jobs.update(id, { phase: 'awaiting_cost' });
          return;
        }
        if (lostLease || !(await jobs.claim(id, token, new Date(Date.now() + 180_000))))
          throw new Error('媒体任务租约已被接管');
        if (!(await meter.settle(call, cost, undefined))) {
          if (Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs + HOLD_MARGIN_MS)
            await jobs.update(id, {
              phase: 'uncertain',
              error: '媒体结果已保存，但费用未闭合，请核对账单',
            });
          throw new Error('长任务结算未确认，将重试');
        }
        if (job.tool === '3d.render')
          await deps.render?.cleanup(
            id,
            (job.call.inputArgs as { assets: unknown[] }).assets.length,
          );
        await jobs.finish(id, 'completed');
      } finally {
        clearInterval(heartbeat);
        try {
          await jobs.mergeCall(id, { nextCheckAt: Date.now() + 30000 });
        } finally {
          await jobs.unlock(id, token);
        }
      }
    })();
    inFlight.set(id, work);
    try {
      await work;
    } finally {
      inFlight.delete(id);
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const job of await jobs.pending(10))
        await processOne(job.id).catch((err: unknown) =>
          deps.logger.warn({ err, jobId: job.id }, '恢复媒体任务失败，保留状态重试'),
        );
      for (const job of await jobs.expired(new Date(), 10)) {
        for (const file of job.result?.files ?? [])
          if (file.id !== undefined) await deps.store.delete(resultKey(job.id, file.id));
        await jobs.update(job.id, { result: null, phase: 'expired' });
      }
    } finally {
      ticking = false;
    }
  }
  async function ownedJob(caller: Caller, id: string) {
    const job = await jobs.get(id);
    const call = job?.call as unknown as MeteredCall | undefined;
    if (
      !job ||
      !call ||
      call.caller.payerId !== caller.payerId ||
      (call.caller.taskId && call.caller.taskId !== caller.taskId) ||
      (!call.caller.taskId && call.caller.runId && call.caller.runId !== caller.runId)
    )
      throw new HttpError(404, 'tool_job_not_found', '没有这个任务号');
    return job;
  }
  async function cancelJob(caller: Caller, id: string) {
    const job = await ownedJob(caller, id);
    if (job.status !== 'pending') return;
    await jobs.requestCancel(id);
    // Intent survives client disconnect and run-key revocation; recovery owns the provider request.
    void processOne(id).catch(() => deps.logger.warn({ jobId: id }, '取消待恢复巡检继续核对'));
  }

  return {
    cancel: cancelJob,
    async cancelRun(caller: Caller, runId: string) {
      await jobs.cancelRun(runId, caller.payerId, caller.taskId);
      for (const job of await jobs.forRun(runId)) await cancelJob(caller, job.id);
    },
    async upload(caller: Caller, id: string, fileId: string, body: Readable) {
      let job = await ownedJob(caller, id);
      const args = RenderArgs.parse(job.call.inputArgs),
        index = Number(fileId),
        asset = args.assets[index];
      if (job.phase !== 'uploading' || job.call.cancelRequested || !asset || !deps.render)
        throw new HttpError(409, 'upload_closed', '上传未开放');
      const token = randomUUID();
      if (!(await jobs.claim(id, token, new Date(Date.now() + 180000))))
        throw new HttpError(409, 'job_busy', '作业处理中');
      const timeout = setTimeout(() => body.destroy(new Error('Upload timeout')), 120000);
      try {
        job = await ownedJob(caller, id);
        if (job.phase !== 'uploading' || job.call.cancelRequested)
          throw new HttpError(409, 'upload_closed', '上传已关闭');
        await deps.store.putStream(deps.render.inputKey(id, index), body, 'model/gltf-binary', {
          maxBytes: asset.size,
          size: asset.size,
          sha256: asset.sha256,
        });
        await jobs.mergeCall(id, {
          uploads: { ...((job.call.uploads as object) ?? {}), [fileId]: true },
        });
      } finally {
        clearTimeout(timeout);
        await jobs.unlock(id, token);
      }
      return { stored: true };
    },
    async submit(caller: Caller, id: string) {
      let job = await ownedJob(caller, id);
      if (job.phase !== 'uploading') return { job: { id } };
      const token = randomUUID();
      if (!(await jobs.claim(id, token, new Date(Date.now() + 180000))))
        throw new HttpError(409, 'job_busy', '作业处理中');
      try {
        job = await ownedJob(caller, id);
        const args = RenderArgs.parse(job.call.inputArgs);
        if (job.call.cancelRequested) throw new HttpError(409, 'job_cancelled', '取消意图已存在');
        if (args.assets.some((_, i) => !(job.call.uploads as Record<string, boolean>)?.[i]))
          throw new HttpError(409, 'inputs_missing', '输入未齐备');
        await jobs.mergeCall(id, { submissionAttempted: true });
        await jobs.update(id, { phase: 'submitting' });
        try {
          const handle = await deps.render!.start(args, id, AbortSignal.timeout(120000));
          await jobs.update(id, { providerJobId: handle, phase: 'pending' });
        } catch {
          await jobs.update(id, { phase: 'uncertain', error: '渲染提交未确认；未自动重发' });
        }
        return { job: { id } };
      } finally {
        await jobs.unlock(id, token);
      }
    },
    async reconcile(
      caller: Caller,
      id: string,
      evidence: { costMicro: number; billId: string; stopped: boolean },
    ) {
      const token = randomUUID();
      await ownedJob(caller, id);
      if (!(await jobs.claim(id, token, new Date(Date.now() + 180000))))
        throw new HttpError(409, 'job_busy', '作业处理中');
      try {
        const job = await ownedJob(caller, id);
        if (
          job.tool !== '3d.render' ||
          !['awaiting_cost', 'uncertain'].includes(job.phase) ||
          !evidence.stopped
        )
          throw new HttpError(409, 'audit_not_ready', '需要费用及停机核验');
        const cap = Number(job.call.holdCeiling);
        if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Missing quote');
        await jobs.mergeCall(id, {
          billingEvidence: evidence,
          terminalAudit: !job.result,
          platformRiskMicro: Math.max(0, evidence.costMicro - cap),
        });
        await jobs.update(id, {
          cost: { costMicro: Math.min(cap, evidence.costMicro), source: 'provider' },
          ...(job.result
            ? { result: { ...job.result, costMicro: Math.min(cap, evidence.costMicro) } }
            : {}),
          phase: 'stored',
        });
      } finally {
        await jobs.unlock(id, token);
      }
      await processOne(id);
    },
    /** 工具目录：没配 Key、或者没有能用的模型的工具标成不可用 */
    async list(): Promise<ToolEntry[]> {
      const blocked = new Set(await meter.regionBlockedModels());
      const entries = TOOLS.map((tool) => {
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
        };
      });
      entries.push({
        key: 'text.batch',
        name: '批量生成文字',
        description:
          '用当前节点模型逐行生成文字，uses 按输入行数估计；支持停止和恢复。单价仅为规划估算，实际按模型 token 计费。',
        usage:
          'oasis-tool text.batch --in 提示.jsonl --out out/结果.jsonl --budget_micro 1000000（每行 {"id":"1","prompt":"要求"}；--resume true 恢复）',
        unit: '行',
        estimateMicro: 2_000,
        long: false,
        available: deps.openrouter.configured,
        models: [],
        defaultModel: null,
      });
      return entries;
    },

    async call(input: {
      caller: Caller;
      key: string;
      args: Record<string, unknown>;
      requestId: string;
      signal: AbortSignal;
      maxCostMicro?: number;
      idempotencyKey?: string;
    }): Promise<ToolResult> {
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
        const pricing = selected?.pricing_skus ?? {};
        const resolution = String(args.resolution);
        // 当前目录同时存在按美分和按美元/秒命名的 SKU；音频默认由供应商决定，冻结取较高档。
        const rates = [
          'duration_seconds',
          'duration_seconds_with_audio',
          `duration_seconds_${resolution}`,
          `duration_seconds_${resolution}_with_audio`,
          `${args.first_frame ? 'image' : 'text'}_to_video_duration_seconds_${resolution}`,
        ]
          .filter((key) => pricing[key] !== undefined)
          .map((key) => Number(pricing[key]));
        for (const key of [
          'cents_per_video_output_second',
          `cents_per_video_output_second_${resolution}`,
        ])
          if (pricing[key] !== undefined) rates.push(Number(pricing[key]) / 100);
        const rate = rates.length ? Math.max(...rates) : NaN;
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
                      await meter.fail(call, `供应商拒绝：${response.status}`);
                      await jobs.finish(id, 'failed', '供应商拒绝了提交');
                      throw new HttpError(502, 'provider_error', '供应商拒绝了提交');
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
          if (
            err instanceof HttpError &&
            err.code === 'provider_region_unavailable' &&
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

    async job(caller: Caller, jobId: string, _signal: AbortSignal): Promise<ToolJobBody> {
      await ownedJob(caller, jobId);
      const work = processOne(jobId).catch((err: unknown) =>
        deps.logger.warn({ err, jobId }, '检查媒体任务失败，保留状态重试'),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 750);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const job = await ownedJob(caller, jobId);
      if (job.phase === 'expired' || (job.expiresAt && job.expiresAt.getTime() < Date.now()))
        throw new HttpError(410, 'tool_result_expired', '工具结果已过期，请使用已交付的成果');
      if (job.phase === 'uncertain')
        return {
          status: 'uncertain',
          error: job.error ?? '供应商结果未确认',
          ...(job.call.cancelRequested === true ? { cancelRequested: true } : {}),
        };
      if (job.status === 'failed') return { status: 'failed', error: job.error ?? '没做出来' };
      if (job.status === 'completed' && job.result)
        return { status: 'completed', result: job.result };
      return {
        status: 'pending',
        ...(job.tool === '3d.render' ? { phase: job.phase } : {}),
        ...(job.call.cancelRequested === true ? { cancelRequested: true } : {}),
      };
    },
    async file(caller: Caller, jobId: string, fileId: string) {
      const job = await ownedJob(caller, jobId);
      if (job.phase === 'expired' || !job.expiresAt || job.expiresAt.getTime() < Date.now())
        throw new HttpError(410, 'tool_result_expired', '工具结果已过期');
      const file =
        job.status === 'completed'
          ? job.result?.files.find((file) => file.id === fileId)
          : undefined;
      if (!file) throw new HttpError(404, 'tool_file_not_found', '没有这个结果文件');
      return { ...file, content: await deps.store.read(resultKey(jobId, fileId)) };
    },
    start() {
      if (!timer) {
        timer = setInterval(() => {
          void tick().catch((err: unknown) => deps.logger.warn({ err }, '媒体任务巡检失败'));
        }, 10_000);
        timer.unref();
        void tick().catch((err: unknown) => deps.logger.warn({ err }, '媒体任务恢复失败'));
      }
    },
    async close() {
      if (timer) clearInterval(timer);
      await Promise.allSettled(inFlight.values());
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

export type ToolService = ReturnType<typeof createToolService>;
