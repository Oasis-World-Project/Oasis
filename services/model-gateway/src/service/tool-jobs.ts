// 长任务（音乐、视频、3D、云渲染、Android 测试）的后台推进：提交后按供应商进度推进——先保存结果再结算，
// 结果未知时保留对账状态，不重发、不认定免费；结果过期或所属任务删除后清理对象存储。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ToolResult } from '@oasis/contracts/model-gateway';
import type { ToolJob } from '../repo/tool-jobs-repo.ts';
import type { MeteredCall } from './metering.ts';
import { HOLD_MARGIN_MS, type ToolContext } from './tool-context.ts';

export function createToolJobs(ctx: ToolContext) {
  const { deps, byKey, resultKey } = ctx;
  const { meter, config, jobs } = deps;
  // 历史版本的工具最多 11 个结果；固定上限同时覆盖旧版未落清单的部分写入。
  const maxResultFiles = 32;
  const inFlight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  async function acceptRenderEvidence(
    job: ToolJob,
    evidence: { costMicro: number; billId: string; stopped: boolean },
  ) {
    const cap = Number(job.call.holdCeiling);
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('Missing quote');
    await jobs.mergeCall(job.id, {
      billingEvidence: evidence,
      terminalAudit: !job.result,
      platformRiskMicro: Math.max(0, evidence.costMicro - cap),
    });
    await jobs.update(job.id, {
      cost: { costMicro: Math.min(cap, evidence.costMicro), source: 'provider' },
      ...(job.result
        ? { result: { ...job.result, costMicro: Math.min(cap, evidence.costMicro) } }
        : {}),
      phase: 'stored',
    });
  }
  /**
   * 提交断连（没拿到供应商作业号）的渲染：超过排队 TTL 与执行时限后，若 endpoint 空闲，
   * 说明这次提交要么没到达、要么已结束，不会再占用 GPU。退回冻结并结案，释放单 GPU 准入；
   * 可能发生的一次执行费用由平台承担。endpoint 仍忙则继续等，不重发。
   */
  async function closeLostSubmit(job: ToolJob) {
    const render = deps.render!;
    if (Date.now() < (job.call.submittedAt as number) + render.lostSubmitQuietMs) return;
    if (!(await render.idle())) return;
    await render.cleanup(job.id, (job.call.inputArgs as { assets: unknown[] }).assets.length);
    const reason = '渲染提交未确认；超过排队与执行时限后核实 GPU 空闲，已自动结案，未扣款';
    await meter.fail(job.call as unknown as MeteredCall, reason);
    await jobs.mergeCall(job.id, { lostSubmitClosed: true });
    await jobs.finish(job.id, 'failed', reason);
  }
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
            await jobs.mergeCall(id, { holdLost: true });
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
          job?.tool === '3d.render' &&
          job.phase === 'uncertain' &&
          !job.providerJobId &&
          !job.cost &&
          !job.call.holdLost &&
          typeof job.call.submittedAt === 'number'
        ) {
          await closeLostSubmit(job);
          return;
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
            browserstack: deps.browserstack,
            receipt: {
              saved: job.call.providerReceipt,
              save: async (value: unknown) => {
                await jobs.mergeCall(id, { providerReceipt: value });
                job.call.providerReceipt = value;
              },
            },
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
                browserstack: deps.browserstack,
                openrouter: deps.openrouter,
                tavily: deps.tavily,
                fal: deps.fal,
                render: deps.render,
                config,
                signal: AbortSignal.timeout(120_000),
                upstream: (request) => request(),
                receipt: {
                  saved: job.call.providerReceipt,
                  save: async (value) => {
                    await jobs.mergeCall(id, { providerReceipt: value });
                  },
                },
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
            if (Date.now() - job.createdAt.getTime() > deps.jobTimeoutMs) {
              if (job.tool === '3d.render') await jobs.requestCancel(id);
              await jobs.update(id, {
                phase: 'uncertain',
                error: '供应商长任务超过等待上限，费用待核对；未自动重发或认定免费',
              });
            }
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
          if (state.outcome.files.length > maxResultFiles) throw new Error('工具结果文件过多');
          for (const [index, file] of state.outcome.files.entries()) {
            const fileId = String(index);
            const taskId = call.caller.taskId;
            if (taskId && (await jobs.taskDeleted(taskId))) {
              file.body?.destroy();
              continue;
            }
            await jobs.mergeCall(id, {
              resultFileIds: [
                ...new Set([
                  ...(Array.isArray(job.call.resultFileIds) ? job.call.resultFileIds : []),
                  ...state.outcome.files.slice(0, index + 1).map((_, n) => String(n)),
                ]),
              ],
              taskFilesCleaned: false,
            });
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
  /** 与归档/结算持有同一作业租约；删除失败保留清单，定时器和事件重投都可重试。 */
  async function cleanResult(id: string, deleted = false) {
    const token = randomUUID();
    if (!(await jobs.claim(id, token, new Date(Date.now() + 180000)))) return;
    try {
      const job = await jobs.get(id);
      if (!job || (!deleted && job.phase !== 'completed')) return;
      const recorded = job.call.resultFileIds;
      const ids = Array.isArray(recorded)
        ? recorded.filter(
            (value): value is string => typeof value === 'string' && /^\d+$/.test(value),
          )
        : Array.from({ length: maxResultFiles }, (_, n) => String(n));
      for (const file of job.result?.files ?? []) if (file.id !== undefined) ids.push(file.id);
      for (const fileId of new Set(ids)) {
        if (!(await jobs.claim(id, token, new Date(Date.now() + 180000))))
          throw new Error('工具清理租约丢失');
        await deps.store.delete(resultKey(id, fileId));
      }
      if (!(await jobs.claim(id, token, new Date(Date.now() + 180000))))
        throw new Error('工具清理租约丢失');
      if (deleted && job.status === 'pending') {
        if (job.result)
          await jobs.update(id, {
            result: { ...job.result, text: '所属任务已删除', data: undefined, files: [] },
          });
        await jobs.mergeCall(id, { resultFileIds: [], taskFilesCleaned: true });
      } else {
        // 终态后才删除可能含原始资产/截图的回执；计费和供应商句柄继续保留用于审计。
        await jobs.mergeCall(id, {
          resultFileIds: [],
          taskFilesCleaned: true,
          providerReceipt: null,
          inputArgs: null,
          uploads: null,
        });
        await jobs.update(id, { result: null, phase: 'expired' });
      }
    } finally {
      await jobs.unlock(id, token);
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
      for (const job of [
        ...(await jobs.deletedResults(10)),
        ...(await jobs.expired(new Date(), 10)),
      ])
        await cleanResult(job.id, job.call.taskDeleted === true).catch((err: unknown) =>
          deps.logger.warn({ err, jobId: job.id }, '工具结果清理失败，将重试'),
        );
    } finally {
      ticking = false;
    }
  }

  return {
    processOne,
    tick,
    acceptRenderEvidence,
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
