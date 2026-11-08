// 长任务的对外接口：查进度、取结果文件、取消、云渲染的上传与提交、费用回执对账、任务删除时清理。
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ToolJobBody } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import { RenderArgs } from '../adapters/runpod.ts';
import type { Caller, MeteredCall } from './metering.ts';
import type { ToolContext } from './tool-context.ts';

export function createToolJobApi(ctx: ToolContext) {
  const { deps, resultKey } = ctx;
  const { jobs } = deps;
  const processOne = (id: string) => ctx.processOne(id);
  const tick = () => ctx.tick();
  const acceptRenderEvidence: ToolContext['acceptRenderEvidence'] = (job, evidence) =>
    ctx.acceptRenderEvidence(job, evidence);
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
    if (call.caller.taskId && (await jobs.taskDeleted(call.caller.taskId)))
      throw new HttpError(410, 'tool_result_deleted', '所属任务已删除');
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
    ownedJob,
    api: {
      async purgeTask(taskId: string) {
        await jobs.markTaskDeleted(taskId);
        await tick();
      },
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
            const handle = await deps.render!.start(
              args,
              id,
              AbortSignal.timeout(120000),
              async () => {
                const until = new Date(Date.now() + 180000);
                if (!(await jobs.claim(id, token, until)))
                  throw new Error('Render submit lease lost');
                const current = await ownedJob(caller, id);
                if (
                  current.status !== 'pending' ||
                  current.phase !== 'submitting' ||
                  current.call.cancelRequested ||
                  Date.now() >= until.getTime()
                )
                  throw new Error('Render submission fenced before POST');
                await jobs.mergeCall(id, { submittedAt: Date.now() });
              },
            );
            await jobs.update(id, { providerJobId: handle, phase: 'pending' });
          } catch {
            const current = await jobs.get(id);
            if (current?.status === 'pending' && current.leaseToken === token)
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
          await acceptRenderEvidence(job, evidence);
          await jobs.mergeCall(id, { manualReconciled: true });
        } finally {
          await jobs.unlock(id, token);
        }
        await processOne(id);
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
    },
  };
}
