import { createHash, randomUUID } from 'node:crypto';
import { BrowserTestPlan, type BrowserTestResult } from '@oasis/contracts/ui-test';
import { createWebsiteFetch, websiteUrl } from '../executor/website-fetch.ts';
import { ApplicationBundle, ApplicationSpec } from '@oasis/contracts/canvas';
import {
  PreviewQuoteBody,
  type PreviewInputBody,
  type PreviewSessionBody,
} from '@oasis/contracts/harness';
import { ComputeHold, ComputeOutcome } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ObjectStore, type ServiceClient } from '@oasis/service-kit';
import type { PreviewExecutor, LivePreview } from '../executor/preview-executor.ts';
import type { PreviewRepo, PreviewRow } from '../repo/preview-repo.ts';
import type { RunService } from './run-service.ts';

type Access = { artifactId: string; ownerId: string; taskId: string };
type Quote = { maxMicro: number; maxMs: number; idleMs: number };

/** 浏览器检查没过时说清楚哪一步、为什么，以及页面自己报的错（交给节点修复，也给用户看） */
function failureReason(report: BrowserTestResult['report']): string {
  const failed = report.steps.filter((step) => step.status === 'failed');
  const parts = [
    ...failed.map((step) => step.error ?? `第 ${step.index + 1} 步 ${step.action} 未通过`),
    ...report.diagnostics.map((message) => `页面诊断：${message}`),
  ];
  return parts.length ? parts.join('；') : '浏览器交互断言或页面诊断未通过';
}

export function createPreviewService(deps: {
  repo: PreviewRepo;
  executor: PreviewExecutor;
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  runs?: RunService;
  store?: ObjectStore;
  cpus: number;
  maxMs: number;
  idleMs: number;
  websiteOrigins?: string[];
}) {
  const live = new Map<string, LivePreview>();
  const lastTouch = new Map<string, number>();
  const inputBudget = new Map<string, { tokens: number; at: number }>();
  const closing = new Map<string, Promise<PreviewRow>>();
  /** 正在做关卡浏览器检查的预览：不按截止时间或无操作回收，只随检查结束、停止或取消结束 */
  const checking = new Set<string>();
  /** 检查跨过多个算力冻结窗口时，前面窗口已结算的金额 */
  const settledBefore = new Map<string, number>();

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
        spentMicro = settled.chargedMicro + (settledBefore.get(row.id) ?? 0);
      }
      settledBefore.delete(row.id);
      await deps.repo.update(row.id, {
        status,
        spentMicro,
        stoppedAt: ended,
        error: error ?? null,
        containerId: null,
      });
      lastTouch.delete(row.id);
      inputBudget.delete(row.id);
      checking.delete(row.id);
      return (await deps.repo.latest(row.artifactId, row.ownerId))!;
    })();
    closing.set(row.id, work);
    try {
      return await work;
    } finally {
      closing.delete(row.id);
    }
  }

  /** 关卡检查持续超过一个算力冻结窗口：结清已经用掉的这一段，再冻结下一段 */
  async function renewCheckCompute(access: Access): Promise<void> {
    const row = await owned(access);
    if (!row?.computeCallId || !row.startedAt || row.status !== 'running') return;
    const now = new Date();
    await deps.modelGateway.json('POST', `/internal/v1/compute/${row.computeCallId}/settle`, {
      body: { cores: deps.cpus, elapsedMs: Math.max(0, now.getTime() - row.startedAt.getTime()) },
      requestId: row.id,
    });
    const settled = await deps.modelGateway.json(
      'GET',
      `/internal/v1/compute/${row.computeCallId}`,
      { schema: ComputeOutcome },
    );
    settledBefore.set(row.id, (settledBefore.get(row.id) ?? 0) + (settled.chargedMicro ?? 0));
    const hold = await deps.modelGateway.json('POST', '/internal/v1/compute', {
      body: {
        runId: row.id,
        payerId: row.ownerId,
        taskId: row.taskId,
        nodeId: null,
        cores: deps.cpus,
        maxMs: deps.maxMs,
        purpose: 'application-check',
      },
      requestId: row.id,
      schema: ComputeHold,
    });
    await deps.repo.update(row.id, {
      computeCallId: hold.callId,
      heldMicro: hold.heldMicro,
      startedAt: now,
      deadlineAt: new Date(now.getTime() + deps.maxMs),
      lastInputAt: now,
    });
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
        if (checking.has(row.id)) continue;
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
    async report(input: { runId: string; payerId: string; taskId: string }) {
      const run = await deps.runs?.get(input.runId);
      if (!run || run.payerId !== input.payerId || run.taskId !== input.taskId)
        throw new HttpError(404, 'run_not_found', '没有这次运行');
      if (!deps.store) throw new HttpError(503, 'check_unavailable', '检查报告暂不可用');
      try {
        return await deps.store.get(`runs/${input.runId}/application-check.json`);
      } catch {
        throw new HttpError(404, 'check_not_found', '这次运行还没有浏览器检查报告');
      }
    },
    async start(
      access: Access,
      supplied?: ApplicationBundle,
      limitMs = deps.maxMs,
      purpose: 'preview' | 'application-check' = 'preview',
      website?: string,
    ): Promise<PreviewSessionBody> {
      const active = await deps.repo.active(access.ownerId);
      if (active) {
        if (active.artifactId === access.artifactId && active.taskId === access.taskId)
          return body(active);
        throw new HttpError(409, 'preview_limit', '请先停止已有预览');
      }
      await deps.executor.check();
      const id = randomUUID();
      // 检查用的会话从一开始就不受截止/无操作回收：启动多慢都等
      if (purpose === 'application-check') checking.add(id);
      const deadlineAt = new Date(Date.now() + limitMs);
      if (!(await deps.repo.insert({ id, ...access, deadlineAt }))) {
        checking.delete(id);
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
          kind: website ? 'website' : bundle.spec.kind,
          ...(website
            ? { website: { url: website, fetch: createWebsiteFetch(deps.websiteOrigins ?? []) } }
            : {}),
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
        checking.delete(id);
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
    /** 任务被删除（ADR 0012）：停掉它还开着的预览，照常结算已用的算力 */
    async checkWebsite(input: {
      url: string;
      plan: BrowserTestPlan;
      payerId: string;
      taskId: string;
    }) {
      websiteUrl(input.url, deps.websiteOrigins ?? []);
      const plan = BrowserTestPlan.parse(input.plan);
      const access = { artifactId: randomUUID(), ownerId: input.payerId, taskId: input.taskId };
      try {
        await this.start(
          access,
          {
            spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
            files: [{ path: 'index.html', contentBase64: 'IA==' }],
          },
          deps.maxMs,
          'application-check',
          input.url,
        );
        const { box } = await running(access);
        const result = await box.test(plan);
        result.report.diagnostics = box.diagnostics();
        if (result.report.diagnostics.length) result.report.passed = false;
        result.report.unchecked.push(
          '仅测试放行来源的 HTTPS GET/HEAD；登录、写请求、WebSocket 和 IPv6 未检查',
        );
        return result;
      } finally {
        const row = await owned(access);
        if (row) await stopRow(row);
      }
    },
    async stopTask(taskId: string): Promise<void> {
      for (const row of (await deps.repo.unfinished()).filter((r) => r.taskId === taskId))
        await stopRow(row);
      // 删除是真删除：结束了的预览记录（已结算）一起删掉
      await deps.repo.removeFinished(taskId);
    },
    async stop(access: Access): Promise<PreviewSessionBody> {
      const row = await owned(access);
      if (!row) throw new HttpError(404, 'preview_not_found', '没有这个预览');
      return body(['stopped', 'expired', 'failed'].includes(row.status) ? row : await stopRow(row));
    },
    /** 节点关卡使用同一隔离浏览器真正打开本次运行包；测试会话同样有冻结、审计与回收。 */
    async checkRun(input: {
      runId: string;
      payerId: string;
      taskId: string;
      /** 用户停止/取消节点时 task 断开请求：立即回收浏览器，不再等结果 */
      signal?: AbortSignal;
    }) {
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
      if (!parsed.success)
        return {
          passed: false,
          reason:
            '应用清单字段错误：' +
            parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '清单'}：${issue.message}`)
              .join('；') +
            `。清单位于 out/${manifestPath}；root 应为相对 out/ 的目录 ${manifestPath.slice(0, manifestPath.lastIndexOf('/'))}，entry 相对 root。实际契约见 in/.oasis-formats.json。`,
          frameCaptured: false,
        };
      if (manifestPath !== `${parsed.data.root}/oasis-app.json`)
        return {
          passed: false,
          reason: `清单位于 out/${manifestPath}，与 root=${parsed.data.root} 不一致；root 相对 out/，entry 相对 root。`,
          frameCaptured: false,
        };
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
      const testFile = members.find((file) => file.path === `${spec.root}/oasis-test.json`);
      let plan: BrowserTestPlan | undefined;
      if (testFile) {
        try {
          plan = BrowserTestPlan.parse(
            JSON.parse((await deps.runs.file(input.runId, testFile.path)).content.toString('utf8')),
          );
        } catch {
          return { passed: false, reason: 'oasis-test.json 测试计划不合法', frameCaptured: false };
        }
      }
      const inputSha256 = createHash('sha256').update(JSON.stringify(bundle.data)).digest('hex');
      const application = {
        manifestPath,
        spec,
        files: members.map((file) => file.path),
        ...(plan ? { plan } : {}),
        network: 'none' as const,
      };
      // 不设时限（2026-11-04 用户决定）：页面多慢都等，由控制端按页面是否安定下结论；
      // 只有检查得出结果、浏览器进程退出，或用户停止/取消节点时才结束。
      const stopOnAbort = () => void this.stop(access).catch(() => undefined);
      input.signal?.addEventListener('abort', stopOnAbort, { once: true });
      let renewal: NodeJS.Timeout | undefined;
      let previewId: string | undefined;
      try {
        input.signal?.throwIfAborted();
        const session = await this.start(access, bundle.data, deps.maxMs, 'application-check');
        previewId = session.id;
        checking.add(session.id);
        // 算力按窗口冻结；检查超过一个窗口就结清上一段、再冻结下一段（不是时限）
        renewal = setInterval(
          () =>
            void renewCheckCompute(access).catch((err: unknown) =>
              deps.logger.warn({ err, previewId }, '浏览器检查的算力续冻失败，下次再试'),
            ),
          Math.max(60_000, Math.floor(deps.maxMs / 2)),
        );
        const box = live.get(session.id)!;
        let opening: { jpegBase64: string } | undefined;
        for (;;) {
          input.signal?.throwIfAborted();
          // 检查程序自己的浏览器没了：这是检查未完成，不是成品失败
          if (!box.alive())
            throw new HttpError(
              503,
              'check_incomplete',
              '检查用的浏览器进程提前结束，没有生成画面',
            );
          try {
            opening = await this.frame(access);
            break;
          } catch (err) {
            if (!(err instanceof HttpError && err.statusCode === 503)) throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const result: BrowserTestResult = plan
          ? await box.test(plan)
          : {
              report: {
                version: 1,
                target: 'application',
                passed: true,
                steps: [],
                diagnostics: [],
                unchecked: ['未提供 oasis-test.json，仅完成启动检查，业务交互未检查'],
              },
              screenshots: [],
            };
        result.report.diagnostics = box.diagnostics();
        if (result.report.diagnostics.length) result.report.passed = false;
        if (deps.store)
          await deps.store.put(
            `runs/${input.runId}/application-check.json`,
            Buffer.from(
              JSON.stringify({ ...result, application, inputSha256, opening: opening?.jpegBase64 }),
            ),
            'application/json',
          );
        return {
          passed: result.report.passed,
          reason: result.report.passed ? null : failureReason(result.report),
          frameCaptured: true,
          report: result.report,
          application,
          inputSha256,
          screenshots: [
            ...(opening ? [{ name: 'opening.jpg', base64: opening.jpegBase64 }] : []),
            ...result.screenshots,
          ],
        };
      } catch (err) {
        if (input.signal?.aborted) throw new HttpError(499, 'check_aborted', '检查已被停止');
        if (err instanceof Error && /应用没有在回环地址|首页返回|net::ERR_/.test(err.message))
          return { passed: false, reason: err.message, frameCaptured: false };
        throw err;
      } finally {
        clearInterval(renewal);
        input.signal?.removeEventListener('abort', stopOnAbort);
        if (previewId) checking.delete(previewId);
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
