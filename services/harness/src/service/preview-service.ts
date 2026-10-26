import { randomUUID } from 'node:crypto';
import { ApplicationBundle, ApplicationSpec } from '@oasis/contracts/canvas';
import {
  PreviewQuoteBody,
  type PreviewInputBody,
  type PreviewSessionBody,
} from '@oasis/contracts/harness';
import { ComputeHold, ComputeOutcome } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { PreviewExecutor, LivePreview } from '../executor/preview-executor.ts';
import type { PreviewRepo, PreviewRow } from '../repo/preview-repo.ts';
import type { RunService } from './run-service.ts';

type Access = { artifactId: string; ownerId: string; taskId: string };
type Quote = { maxMicro: number; maxMs: number; idleMs: number };

export function createPreviewService(deps: {
  repo: PreviewRepo;
  executor: PreviewExecutor;
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  runs?: RunService;
  cpus: number;
  maxMs: number;
  idleMs: number;
}) {
  const live = new Map<string, LivePreview>();
  const lastTouch = new Map<string, number>();
  const inputBudget = new Map<string, { tokens: number; at: number }>();
  const closing = new Map<string, Promise<PreviewRow>>();

  const body = (row: PreviewRow): PreviewSessionBody => ({
    id: row.id,
    artifactId: row.artifactId,
    status: row.status,
    heldMicro: row.heldMicro,
    spentMicro: row.spentMicro,
    startedAt: row.startedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt.toISOString(),
    error: row.error,
  });

  async function owned(access: Access): Promise<PreviewRow | undefined> {
    const row = await deps.repo.latest(access.artifactId, access.ownerId);
    if (row && row.taskId !== access.taskId)
      throw new HttpError(404, 'preview_not_found', '没有这个预览');
    return row;
  }

  async function quote(): Promise<Quote> {
    const value = await deps.modelGateway.json(
      'GET',
      `/internal/v1/compute/quote?cores=${deps.cpus}&maxMs=${deps.maxMs}`,
      {
        schema: PreviewQuoteBody.pick({ maxMicro: true }),
      },
    );
    return { maxMicro: value.maxMicro, maxMs: deps.maxMs, idleMs: deps.idleMs };
  }

  async function stopRow(
    row: PreviewRow,
    status: 'stopped' | 'expired' | 'failed' = 'stopped',
    error?: string,
  ): Promise<PreviewRow> {
    const prior = closing.get(row.id);
    if (prior) return prior;
    const work = (async () => {
      await deps.repo.update(row.id, { status: 'stopping' });
      const running = live.get(row.id);
      if (running) await running.destroy();
      else if (row.containerId) await deps.executor.destroy(row.containerId);
      live.delete(row.id);
      // 先持久化容器真正销毁的时间；结算失败重试时不能把等待时间算成运行时间。
      const ended = row.stoppedAt ?? new Date();
      if (!row.stoppedAt) await deps.repo.update(row.id, { stoppedAt: ended, containerId: null });
      let spentMicro = 0;
      if (row.computeCallId) {
        const elapsedMs = row.startedAt
          ? Math.min(deps.maxMs, Math.max(0, ended.getTime() - row.startedAt.getTime()))
          : 0;
        await deps.modelGateway.json('POST', `/internal/v1/compute/${row.computeCallId}/settle`, {
          body: { cores: deps.cpus, elapsedMs },
          requestId: row.id,
        });
        const settled = await deps.modelGateway.json(
          'GET',
          `/internal/v1/compute/${row.computeCallId}`,
          { schema: ComputeOutcome },
        );
        if (settled.status !== 'succeeded' || settled.chargedMicro === null)
          throw new Error('预览算力尚未完成结算');
        spentMicro = settled.chargedMicro;
      }
      await deps.repo.update(row.id, {
        status,
        spentMicro,
        stoppedAt: ended,
        error: error ?? null,
        containerId: null,
      });
      lastTouch.delete(row.id);
      inputBudget.delete(row.id);
      return (await deps.repo.latest(row.artifactId, row.ownerId))!;
    })();
    closing.set(row.id, work);
    try {
      return await work;
    } finally {
      closing.delete(row.id);
    }
  }

  async function current(access: Access) {
    const row = await owned(access);
    return row ? body(row) : null;
  }

  async function activity(row: PreviewRow) {
    const now = Date.now();
    if (now - (lastTouch.get(row.id) ?? 0) < 10_000) return;
    lastTouch.set(row.id, now);
    await deps.repo.update(row.id, { lastInputAt: new Date(now) });
  }

  async function running(access: Access) {
    const row = await owned(access);
    if (!row || row.status !== 'running')
      throw new HttpError(409, 'preview_not_running', '预览还没有运行');
    const box = live.get(row.id);
    if (!box) throw new HttpError(503, 'preview_recovering', '预览正在恢复，请稍后重开');
    return { row, box };
  }

  const timer = setInterval(() => {
    void (async () => {
      for (const row of await deps.repo.unfinished()) {
        if (row.status === 'stopping') {
          await stopRow(row).catch((err: unknown) =>
            deps.logger.warn({ err, previewId: row.id }, '重试停止预览失败'),
          );
          continue;
        }
        const now = Date.now();
        const idle =
          row.lastInputAt?.getTime() ?? row.startedAt?.getTime() ?? row.createdAt.getTime();
        if (now >= row.deadlineAt.getTime() || now - idle >= deps.idleMs)
          await stopRow(row, 'expired').catch((err: unknown) =>
            deps.logger.warn({ err, previewId: row.id }, '预览过期回收失败'),
          );
      }
      const pending = await deps.repo.unfinished();
      await deps.executor.removeOrphans(new Set(pending.map((row) => row.id)));
    })().catch((err: unknown) => deps.logger.warn({ err }, '预览会话巡检失败'));
  }, 10_000);
  timer.unref();

  return {
    quote,
    current,
    async start(
      access: Access,
      supplied?: ApplicationBundle,
      limitMs = deps.maxMs,
      purpose: 'preview' | 'application-check' = 'preview',
    ): Promise<PreviewSessionBody> {
      const active = await deps.repo.active(access.ownerId);
      if (active) {
        if (active.artifactId === access.artifactId && active.taskId === access.taskId)
          return body(active);
        throw new HttpError(409, 'preview_limit', '请先停止已有预览');
      }
      await deps.executor.check();
      const id = randomUUID();
      const deadlineAt = new Date(Date.now() + limitMs);
      if (!(await deps.repo.insert({ id, ...access, deadlineAt }))) {
        const again = await deps.repo.active(access.ownerId);
        if (again?.artifactId === access.artifactId) return body(again);
        throw new HttpError(409, 'preview_limit', '请先停止已有预览');
      }
      try {
        const bundle =
          supplied ??
          (await deps.canvas.json('POST', '/internal/applications/lookup', {
            body: access,
            requestId: id,
            schema: ApplicationBundle,
          }));
        const files = bundle.files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.contentBase64, 'base64'),
        }));
        const size = files.reduce((sum, file) => sum + file.content.length, 0);
        if (size > 100 * 1024 * 1024 || !files.some((file) => file.path === bundle.spec.entry))
          throw new HttpError(422, 'application_invalid', '应用入口或文件大小不合格');
        const hold = await deps.modelGateway.json('POST', '/internal/v1/compute', {
          body: {
            runId: id,
            payerId: access.ownerId,
            taskId: access.taskId,
            nodeId: null,
            cores: deps.cpus,
            maxMs: limitMs,
            purpose,
          },
          requestId: id,
          schema: ComputeHold,
        });
        await deps.repo.update(id, { computeCallId: hold.callId, heldMicro: hold.heldMicro });
        const box = await deps.executor.start({
          id,
          kind: bundle.spec.kind,
          entry: bundle.spec.entry,
          files,
        });
        live.set(id, box);
        const startedAt = new Date();
        await deps.repo.update(id, { containerId: box.id, startedAt, lastInputAt: startedAt });
        await box.ready();
        await deps.repo.update(id, { status: 'running' });
        return body((await deps.repo.latest(access.artifactId, access.ownerId))!);
      } catch (err) {
        const row = await deps.repo.latest(access.artifactId, access.ownerId);
        if (row?.id === id) {
          await stopRow(row, 'failed', err instanceof Error ? err.message : String(err)).catch(
            (cleanup: unknown) =>
              deps.logger.error({ err: cleanup, previewId: id }, '预览失败后回收未完成'),
          );
        }
        throw err;
      }
    },
    async stop(access: Access): Promise<PreviewSessionBody> {
      const row = await owned(access);
      if (!row) throw new HttpError(404, 'preview_not_found', '没有这个预览');
      return body(['stopped', 'expired', 'failed'].includes(row.status) ? row : await stopRow(row));
    },
    /** 节点关卡使用同一隔离浏览器真正打开本次运行包；测试会话同样有冻结、审计与回收。 */
    async checkRun(input: { runId: string; payerId: string; taskId: string }) {
      if (!deps.runs) throw new HttpError(503, 'check_unavailable', '浏览器检查暂不可用');
      const run = await deps.runs.get(input.runId);
      if (
        run.payerId !== input.payerId ||
        run.taskId !== input.taskId ||
        run.status !== 'succeeded'
      )
        throw new HttpError(404, 'run_not_found', '没有这次运行');
      const manifestPath = run.outputs.find((file) => file.path.endsWith('/oasis-app.json'))?.path;
      if (!manifestPath) throw new HttpError(422, 'manifest_missing', '没有应用清单');
      const manifest = await deps.runs.file(input.runId, manifestPath);
      let description: unknown;
      try {
        description = JSON.parse(manifest.content.toString('utf8'));
      } catch {
        return { passed: false, reason: '应用清单不是 JSON', frameCaptured: false };
      }
      const parsed = ApplicationSpec.safeParse(description);
      if (!parsed.success || manifestPath !== `${parsed.data.root}/oasis-app.json`)
        return { passed: false, reason: '应用清单格式或位置不合格', frameCaptured: false };
      const spec = parsed.data;
      const members = run.outputs.filter(
        (file) => file.path.startsWith(`${spec.root}/`) && file.size > 0,
      );
      if (
        members.length > 1000 ||
        members.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024 ||
        !members.some((file) => file.path === `${spec.root}/${spec.entry}`)
      )
        return { passed: false, reason: '应用文件数量、大小或入口不合格', frameCaptured: false };
      const assembled: ApplicationBundle = {
        spec,
        files: await Promise.all(
          members.map(async (file) => ({
            path: file.path.slice(spec.root.length + 1),
            contentBase64: (await deps.runs!.file(input.runId, file.path)).content.toString(
              'base64',
            ),
          })),
        ),
      };
      const bundle = ApplicationBundle.safeParse(assembled);
      if (!bundle.success)
        return { passed: false, reason: '运行包包含不安全路径或格式', frameCaptured: false };
      const access = { artifactId: input.runId, ownerId: input.payerId, taskId: input.taskId };
      try {
        await this.start(access, bundle.data, 60_000, 'application-check');
        const waitUntil = Date.now() + 8_000;
        while (Date.now() < waitUntil) {
          try {
            await this.frame(access);
            await new Promise((resolve) => setTimeout(resolve, 600));
            const diagnostics = live.get((await owned(access))!.id)?.diagnostics() ?? [];
            return diagnostics.length
              ? { passed: false, reason: diagnostics.join('；'), frameCaptured: true }
              : { passed: true, reason: null, frameCaptured: true };
          } catch (err) {
            if (!(err instanceof HttpError && err.statusCode === 503)) throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { passed: false, reason: '浏览器没有生成可见画面', frameCaptured: false };
      } catch (err) {
        if (err instanceof Error && /应用没有在回环地址|首页返回|net::ERR_/.test(err.message))
          return { passed: false, reason: err.message, frameCaptured: false };
        throw err;
      } finally {
        await this.stop(access).catch((err: unknown) =>
          deps.logger.warn({ err, runId: input.runId }, '浏览器检查结束后回收失败'),
        );
      }
    },
    async frame(access: Access) {
      const { box } = await running(access);
      const frame = box.frame();
      if (!frame) throw new HttpError(503, 'preview_frame_pending', '预览画面正在准备');
      return frame;
    },
    async audio(access: Access, afterSeq: number) {
      const { box } = await running(access);
      return { chunks: box.audio(afterSeq) };
    },
    async input(access: Access, value: PreviewInputBody) {
      const { row, box } = await running(access);
      const now = Date.now();
      const prior = inputBudget.get(row.id) ?? { tokens: 40, at: now };
      const tokens = Math.min(40, prior.tokens + (now - prior.at) * 0.04);
      if (tokens < 1) throw new HttpError(429, 'preview_input_rate', '操作太快，请稍后再试');
      inputBudget.set(row.id, { tokens: tokens - 1, at: now });
      await activity(row);
      box.input(value);
    },
    async recover() {
      for (const row of await deps.repo.unfinished()) {
        await stopRow(row, 'stopped', '服务重启，预览已停止；可再次打开').catch((err: unknown) =>
          deps.logger.warn({ err, previewId: row.id }, '预览恢复结算失败'),
        );
      }
      const stillPending = await deps.repo.unfinished();
      await deps.executor.removeOrphans(new Set(stillPending.map((row) => row.id)));
    },
    async close() {
      clearInterval(timer);
      for (const row of await deps.repo.unfinished())
        await stopRow(row).catch((err: unknown) =>
          deps.logger.warn({ err, previewId: row.id }, '关闭预览失败'),
        );
    },
  };
}

export type PreviewService = ReturnType<typeof createPreviewService>;
