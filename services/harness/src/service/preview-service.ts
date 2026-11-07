// 隔离浏览器里的网页检查（ADR 0009、0017、0021）：节点自查 app.check、节点关卡、外站测试共用。
// 画面转发给用户看的「平台预览」已删除（ADR 0021）；这里的浏览器只给检查用：每次检查开一个、用完即停，
// 记在 check_browsers 里（容器、算力冻结），重启后据此停掉遗留的浏览器、按实际时长结算。
import { createHash, randomUUID } from 'node:crypto';
import { LIVE_SANDBOX, livePage } from '@oasis/live-page';
import { BrowserTestPlan, type BrowserTestResult } from '@oasis/contracts/ui-test';
import { createWebsiteFetch, websiteUrl } from '../executor/website-fetch.ts';
import { ApplicationBundle, ApplicationSpec } from '@oasis/contracts/canvas';
import { type ApplicationCheckResult } from '@oasis/contracts/harness';
import { ComputeHold, ComputeOutcome } from '@oasis/contracts/model-gateway';
import { HttpError, type Logger, type ObjectStore, type ServiceClient } from '@oasis/service-kit';
import type { PreviewExecutor, LivePreview } from '../executor/preview-executor.ts';
import type { BrowserRepo } from '../repo/browser-repo.ts';
import type { RunService } from './run-service.ts';

/** 检查谁付钱、算在哪个任务上 */
type Access = { payerId: string; taskId: string };

/** 画布运行网页的规则，交给节点看（没过时写进原因） */
const CANVAS_RULE =
  '画布把网页放进不联网的隔离框运行：<script>/<link>/<img> 和 ES 模块 import（含 importmap）引用同目录文件可以；' +
  'fetch/XHR 读本地文件、CDN、localStorage 不行，模型等数据请内嵌成 data: 地址或 JS 里的常量。';

/** 浏览器检查没过时说清楚哪一步、为什么，以及页面自己报的错（交给节点修复，也给用户看） */
function failureReason(report: BrowserTestResult['report']): string {
  const failed = report.steps.filter((step) => step.status === 'failed');
  const parts = [
    ...failed.map((step) => step.error ?? `第 ${step.index + 1} 步 ${step.action} 未通过`),
    ...report.diagnostics.map((message) => `页面诊断：${message}`),
  ];
  return parts.length ? parts.join('；') : '浏览器交互断言或页面诊断未通过';
}

type Failure = { passed: false; reason: string; frameCaptured: false };
const fail = (reason: string): Failure => ({ passed: false, reason, frameCaptured: false });

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * 静态网页按画布的方式组装（ADR 0021）：入口换成一个只放隔离框的外壳，框里是和画布一模一样的文档。
 * 浏览器检查跑的就是用户在画布里看到的那份；画布里加载不了的文件直接算没通过。
 */
async function asCanvasPage(
  bundle: ApplicationBundle,
): Promise<{ bundle: ApplicationBundle } | Failure> {
  if (bundle.spec.kind !== 'static') return { bundle };
  const files = new Map(bundle.files.map((file) => [file.path, file.contentBase64]));
  const entry = files.get(bundle.spec.entry);
  if (entry === undefined) return fail('应用入口文件缺失');
  const page = await livePage(
    Buffer.from(entry, 'base64').toString('utf8'),
    bundle.spec.entry,
    '',
    async (path) => {
      const content = files.get(path);
      return content === undefined ? undefined : new Uint8Array(Buffer.from(content, 'base64'));
    },
  );
  if (page.missing.length) {
    // 运行包里的路径相对应用目录；说给节点听时换回 out/ 下的路径
    const missing = page.missing.map((item) => `${bundle.spec.root}/${item}`);
    return fail(
      `这些文件在画布里加载不了：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}。${CANVAS_RULE}`,
    );
  }
  const host =
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}' +
    'iframe{display:block;border:0;width:100%;height:100%}</style>' +
    `<iframe title="oasis-live" sandbox="${LIVE_SANDBOX}" allow="autoplay; fullscreen" srcdoc="${escapeAttr(page.html)}"></iframe>`;
  files.set(bundle.spec.entry, Buffer.from(host).toString('base64'));
  return {
    bundle: {
      spec: bundle.spec,
      files: [...files].map(([path, contentBase64]) => ({ path, contentBase64 })),
    },
  };
}

/**
 * 按清单把 out/ 里的网页成果组装成运行包（关卡和节点自查共用）：清单、入口、大小、测试计划不合格时
 * 直接返回没通过的原因，不启动浏览器。
 */
async function assemble(
  manifestPath: string,
  outputs: { path: string; size: number }[],
  read: (path: string) => Promise<Buffer>,
) {
  let description: unknown;
  try {
    description = JSON.parse((await read(manifestPath)).toString('utf8'));
  } catch {
    return fail('应用清单不是 JSON');
  }
  const parsed = ApplicationSpec.safeParse(description);
  if (!parsed.success)
    return fail(
      '应用清单字段错误：' +
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '清单'}：${issue.message}`)
          .join('；') +
        `。清单位于 out/${manifestPath}；root 应为相对 out/ 的目录 ${manifestPath.slice(0, manifestPath.lastIndexOf('/'))}，entry 相对 root。实际契约见 in/.oasis-formats.json。`,
    );
  if (manifestPath !== `${parsed.data.root}/oasis-app.json`)
    return fail(
      `清单位于 out/${manifestPath}，与 root=${parsed.data.root} 不一致；root 相对 out/，entry 相对 root。`,
    );
  const spec = parsed.data;
  const members = outputs.filter((file) => file.path.startsWith(`${spec.root}/`) && file.size > 0);
  if (
    members.length > 1000 ||
    members.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024 ||
    !members.some((file) => file.path === `${spec.root}/${spec.entry}`)
  )
    return fail('应用文件数量、大小或入口不合格');
  const bundle = ApplicationBundle.safeParse({
    spec,
    files: await Promise.all(
      members.map(async (file) => ({
        path: file.path.slice(spec.root.length + 1),
        contentBase64: (await read(file.path)).toString('base64'),
      })),
    ),
  });
  if (!bundle.success) return fail('运行包包含不安全路径或格式');
  const testFile = members.find((file) => file.path === `${spec.root}/oasis-test.json`);
  // 测试计划放错目录时说清楚，不当成「没写测试」悄悄跳过
  const misplaced = outputs.find(
    (file) =>
      file !== testFile &&
      (file.path === 'oasis-test.json' || file.path.endsWith('/oasis-test.json')),
  );
  if (!testFile && misplaced)
    return fail(
      `oasis-test.json 放在了 out/${misplaced.path}，要和 oasis-app.json 一起放进 out/${spec.root}/ 才会执行。`,
    );
  const canvas = await asCanvasPage(bundle.data);
  if ('reason' in canvas) return canvas;
  let plan: BrowserTestPlan | undefined;
  if (testFile) {
    try {
      plan = BrowserTestPlan.parse(JSON.parse((await read(testFile.path)).toString('utf8')));
    } catch {
      return fail('oasis-test.json 测试计划不合法');
    }
  }
  return {
    // 浏览器打开的是画布那一份；留档的摘要仍按交付的原文件算
    bundle: canvas.bundle,
    plan,
    inputSha256: createHash('sha256').update(JSON.stringify(bundle.data)).digest('hex'),
    application: {
      manifestPath,
      spec,
      files: members.map((file) => file.path),
      ...(plan ? { plan } : {}),
      network: 'none' as const,
    },
  };
}

/** 还没停好的检查浏览器 */
const ACTIVE = ['starting', 'running', 'stopping'];

export function createPreviewService(deps: {
  repo: BrowserRepo;
  executor: PreviewExecutor;
  modelGateway: ServiceClient;
  logger: Logger;
  runs?: RunService;
  store?: ObjectStore;
  cpus: number;
  maxMs: number;
  websiteOrigins?: string[];
}) {
  /** 这个进程开着的浏览器 */
  const live = new Map<string, LivePreview>();
  /** 这个进程正在用的检查；不在这里的未结束记录是上次进程留下的 */
  const mine = new Set<string>();
  const closing = new Map<string, Promise<void>>();
  /** 检查跨过多个算力冻结窗口时，前面窗口已结算的金额 */
  const settledBefore = new Map<string, number>();

  const holdCompute = (id: string, access: Access) =>
    deps.modelGateway.json('POST', '/internal/v1/compute', {
      body: {
        runId: id,
        payerId: access.payerId,
        taskId: access.taskId,
        nodeId: null,
        cores: deps.cpus,
        maxMs: deps.maxMs,
        purpose: 'application-check',
      },
      requestId: id,
      schema: ComputeHold,
    });

  /** 结清一段算力冻结，返回这一段实际扣的钱 */
  async function settle(id: string, callId: string, elapsedMs: number): Promise<number> {
    await deps.modelGateway.json('POST', `/internal/v1/compute/${callId}/settle`, {
      body: { cores: deps.cpus, elapsedMs },
      requestId: id,
    });
    const settled = await deps.modelGateway.json('GET', `/internal/v1/compute/${callId}`, {
      schema: ComputeOutcome,
    });
    if (settled.status !== 'succeeded' || settled.chargedMicro === null)
      throw new Error('检查用浏览器的算力尚未完成结算');
    return settled.chargedMicro;
  }

  /** 停掉一个检查用的浏览器，按实际时长结算；重复调用只做一次，已经停好的不再动 */
  function stopBrowser(
    id: string,
    status: 'stopped' | 'failed' = 'stopped',
    error?: string,
  ): Promise<void> {
    const prior = closing.get(id);
    if (prior) return prior;
    // 先从「正在用」里拿掉：还在开的检查据此知道被停了，停到一半失败时巡检会接着停
    mine.delete(id);
    const work = (async () => {
      const row = await deps.repo.get(id);
      if (!row || !ACTIVE.includes(row.status)) return;
      await deps.repo.update(id, { status: 'stopping' });
      const box = live.get(id);
      if (box) await box.destroy();
      else if (row.containerId) await deps.executor.destroy(row.containerId);
      live.delete(id);
      // 先持久化浏览器真正销毁的时间；结算失败重试时不能把等待时间算成运行时间。
      const ended = row.stoppedAt ?? new Date();
      if (!row.stoppedAt) await deps.repo.update(id, { stoppedAt: ended, containerId: null });
      const elapsedMs = row.startedAt
        ? Math.min(deps.maxMs, Math.max(0, ended.getTime() - row.startedAt.getTime()))
        : 0;
      const spentMicro =
        (row.computeCallId ? await settle(id, row.computeCallId, elapsedMs) : 0) +
        (settledBefore.get(id) ?? 0);
      settledBefore.delete(id);
      await deps.repo.update(id, { status, spentMicro, error: error ?? null });
    })();
    closing.set(id, work);
    return work.finally(() => closing.delete(id));
  }

  /** 检查持续超过一个算力冻结窗口：结清已经用掉的这一段，再冻结下一段（不是时限） */
  async function renewCompute(id: string): Promise<void> {
    const row = await deps.repo.get(id);
    if (!row?.computeCallId || !row.startedAt || row.status !== 'running') return;
    const now = new Date();
    const spent = await settle(
      id,
      row.computeCallId,
      Math.max(0, now.getTime() - row.startedAt.getTime()),
    );
    settledBefore.set(id, (settledBefore.get(id) ?? 0) + spent);
    const hold = await holdCompute(id, row);
    await deps.repo.update(id, {
      computeCallId: hold.callId,
      heldMicro: hold.heldMicro,
      startedAt: now,
    });
  }

  /** 检查期间被停了（用户停止、服务关闭）：已经起来的浏览器自己收掉 */
  async function abandon(id: string, box?: LivePreview): Promise<never> {
    await box?.destroy().catch(() => undefined);
    live.delete(id);
    throw new HttpError(499, 'check_aborted', '检查已被停止');
  }

  /** 开一个检查用的浏览器：先记下、冻结算力，再起容器；没开成就停掉、结算 */
  async function openBrowser(
    id: string,
    access: Access,
    bundle: ApplicationBundle,
    website?: string,
  ): Promise<LivePreview> {
    const files = bundle.files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.contentBase64, 'base64'),
    }));
    const size = files.reduce((sum, file) => sum + file.content.length, 0);
    if (size > 100 * 1024 * 1024 || !files.some((file) => file.path === bundle.spec.entry))
      throw new HttpError(422, 'application_invalid', '应用入口或文件大小不合格');
    await deps.executor.check();
    mine.add(id);
    await deps.repo.insert({ id, ...access });
    try {
      const hold = await holdCompute(id, access);
      await deps.repo.update(id, { computeCallId: hold.callId, heldMicro: hold.heldMicro });
      if (!mine.has(id)) return await abandon(id);
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
      if (!mine.has(id)) return await abandon(id, box);
      await deps.repo.update(id, { containerId: box.id, startedAt: new Date() });
      await box.ready();
      if (!mine.has(id)) return await abandon(id, box);
      await deps.repo.update(id, { status: 'running' });
      return box;
    } catch (err) {
      // 被停掉的（用户停止、服务关闭）记为停止；其余记为失败并留下原因
      const failed = mine.has(id);
      await stopBrowser(
        id,
        failed ? 'failed' : 'stopped',
        failed ? (err instanceof Error ? err.message : String(err)) : undefined,
      ).catch((cleanup: unknown) =>
        deps.logger.error({ err: cleanup, browserId: id }, '检查用浏览器没开成，回收未完成'),
      );
      throw err;
    }
  }

  /** 在隔离浏览器里打开网页包、按测试计划操作；检查程序自己出错时抛出，页面问题如实返回 */
  async function browse(
    access: Access,
    bundle: ApplicationBundle,
    plan: BrowserTestPlan | undefined,
    signal?: AbortSignal,
  ): Promise<
    | Failure
    | {
        report: BrowserTestResult['report'];
        steps: BrowserTestResult['screenshots'];
        opening?: string;
      }
  > {
    // 不设时限（2026-11-04 用户决定）：页面多慢都等，由控制端按页面是否安定下结论；
    // 只有检查得出结果、浏览器进程退出，或用户停止/取消节点时才结束。
    const id = randomUUID();
    const stopOnAbort = () => void stopBrowser(id).catch(() => undefined);
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    let renewal: NodeJS.Timeout | undefined;
    try {
      signal?.throwIfAborted();
      const box = await openBrowser(id, access, bundle);
      // 算力按窗口冻结；检查超过一个窗口就结清上一段、再冻结下一段（不是时限）
      renewal = setInterval(
        () =>
          void renewCompute(id).catch((err: unknown) =>
            deps.logger.warn({ err, browserId: id }, '浏览器检查的算力续冻失败，下次再试'),
          ),
        Math.max(60_000, Math.floor(deps.maxMs / 2)),
      );
      let opening: { jpegBase64: string } | undefined;
      while (!opening) {
        signal?.throwIfAborted();
        // 检查程序自己的浏览器没了：这是检查未完成，不是成品失败
        if (!box.alive())
          throw new HttpError(503, 'check_incomplete', '检查用的浏览器进程提前结束，没有生成画面');
        opening = box.frame();
        if (!opening) await new Promise((resolve) => setTimeout(resolve, 200));
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
              unchecked: [
                '应用目录里没有 oasis-test.json（要和 oasis-app.json 放在同一目录），只做了启动和画面检查，业务交互未检查',
              ],
            },
            screenshots: [],
          };
      // 画面检查（ADR 0021）：等页面画出来；一直是一整片纯色就算没画出东西
      const look = await box.look();
      result.report.diagnostics = box.diagnostics();
      if (look.blank)
        result.report.diagnostics.push(
          `画面检查：打开后一直是一整片纯色（${look.color ?? '单色'}），看起来什么都没画出来`,
        );
      if (result.report.diagnostics.length) result.report.passed = false;
      return { report: result.report, steps: result.screenshots, opening: opening.jpegBase64 };
    } catch (err) {
      if (signal?.aborted) throw new HttpError(499, 'check_aborted', '检查已被停止');
      if (err instanceof Error && /应用没有在回环地址|首页返回|net::ERR_/.test(err.message))
        return fail(err.message);
      throw err;
    } finally {
      clearInterval(renewal);
      signal?.removeEventListener('abort', stopOnAbort);
      await stopBrowser(id).catch((err: unknown) =>
        deps.logger.warn({ err, browserId: id }, '浏览器检查结束后回收失败'),
      );
    }
  }

  /** 停掉上次进程留下的、停到一半的浏览器，清掉没有记录的容器 */
  async function sweep(): Promise<void> {
    for (const row of await deps.repo.unfinished()) {
      if (mine.has(row.id)) continue;
      await stopBrowser(
        row.id,
        'stopped',
        row.status === 'stopping' ? undefined : '服务重启，检查已停止',
      ).catch((err: unknown) =>
        deps.logger.warn({ err, browserId: row.id }, '回收遗留的检查浏览器失败'),
      );
    }
    // 正在开的检查先记进 mine 再写记录、起容器，一起留下，免得刚起的容器被当成没有记录的清掉
    const pending = await deps.repo.unfinished();
    await deps.executor.removeOrphans(new Set([...pending.map((row) => row.id), ...mine]));
  }

  const timer = setInterval(() => {
    void sweep().catch((err: unknown) => deps.logger.warn({ err }, '检查浏览器巡检失败'));
  }, 10_000);
  timer.unref();

  return {
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
    /** 外站测试（website.test）：只按测试计划访问放行来源的 HTTPS 页面 */
    async checkWebsite(input: {
      url: string;
      plan: BrowserTestPlan;
      payerId: string;
      taskId: string;
    }) {
      websiteUrl(input.url, deps.websiteOrigins ?? []);
      const plan = BrowserTestPlan.parse(input.plan);
      const id = randomUUID();
      try {
        const box = await openBrowser(
          id,
          { payerId: input.payerId, taskId: input.taskId },
          {
            spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
            files: [{ path: 'index.html', contentBase64: 'IA==' }],
          },
          input.url,
        );
        const result = await box.test(plan);
        result.report.diagnostics = box.diagnostics();
        if (result.report.diagnostics.length) result.report.passed = false;
        result.report.unchecked.push(
          '仅测试放行来源的 HTTPS GET/HEAD；登录、写请求、WebSocket 和 IPv6 未检查',
        );
        return result;
      } finally {
        await stopBrowser(id);
      }
    },
    /** 任务被删除（ADR 0012 §15）：停掉它还开着的检查浏览器、照常结算，再把记录真删除 */
    async stopTask(taskId: string): Promise<void> {
      for (const row of (await deps.repo.unfinished()).filter((r) => r.taskId === taskId))
        await stopBrowser(row.id);
      await deps.repo.removeFinished(taskId);
    },
    /** 节点关卡：打开本次运行交出的网页包；报告留档，供用户下载。 */
    async checkRun(input: {
      runId: string;
      payerId: string;
      taskId: string;
      /** 用户停止/取消节点时 task 断开请求：立即回收浏览器，不再等结果 */
      signal?: AbortSignal;
    }): Promise<ApplicationCheckResult> {
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
      const prepared = await assemble(
        manifestPath,
        run.outputs,
        async (path) => (await deps.runs!.file(input.runId, path)).content,
      );
      if ('reason' in prepared) return prepared;
      const checked = await browse(
        { payerId: input.payerId, taskId: input.taskId },
        prepared.bundle,
        prepared.plan,
        input.signal,
      );
      if (!('report' in checked)) return checked;
      const { application, inputSha256 } = prepared;
      if (deps.store)
        await deps.store.put(
          `runs/${input.runId}/application-check.json`,
          Buffer.from(
            JSON.stringify({
              report: checked.report,
              screenshots: checked.steps,
              application,
              inputSha256,
              opening: checked.opening,
            }),
          ),
          'application/json',
        );
      return {
        passed: checked.report.passed,
        reason: checked.report.passed ? null : failureReason(checked.report),
        frameCaptured: true,
        report: checked.report,
        application,
        inputSha256,
        screenshots: [
          ...(checked.opening ? [{ name: 'opening.jpg', base64: checked.opening }] : []),
          ...checked.steps,
        ],
      };
    },
    /**
     * 节点自查（ADR 0017 的 app.check）：直接读运行中沙箱里 out/<dir> 的当前文件，
     * 用和关卡同一套隔离浏览器检查跑一遍；不留档，结果当场交回节点。
     */
    async checkLive(input: {
      runId: string;
      payerId: string;
      taskId: string;
      dir: string;
      signal?: AbortSignal;
    }): Promise<ApplicationCheckResult> {
      if (!deps.runs) throw new HttpError(503, 'check_unavailable', '浏览器检查暂不可用');
      const files = await deps.runs.liveFiles(input);
      const prefixed = new Map(files.map((file) => [`${input.dir}/${file.path}`, file.content]));
      const manifestPath = `${input.dir}/oasis-app.json`;
      if (!prefixed.has(manifestPath))
        return fail(`out/${input.dir} 里没有 oasis-app.json；实际契约见 in/.oasis-formats.json`);
      const prepared = await assemble(
        manifestPath,
        [...prefixed].map(([path, content]) => ({ path, size: content.length })),
        async (path) => prefixed.get(path)!,
      );
      if ('reason' in prepared) return prepared;
      const checked = await browse(
        { payerId: input.payerId, taskId: input.taskId },
        prepared.bundle,
        prepared.plan,
        input.signal,
      );
      if (!('report' in checked)) return checked;
      return {
        passed: checked.report.passed,
        reason: checked.report.passed ? null : failureReason(checked.report),
        frameCaptured: true,
        report: checked.report,
      };
    },
    /** 服务启动：上次进程留下的浏览器都停掉、结算，再清掉没有记录的容器 */
    recover: sweep,
    async close() {
      clearInterval(timer);
      for (const row of await deps.repo.unfinished())
        await stopBrowser(row.id).catch((err: unknown) =>
          deps.logger.warn({ err, browserId: row.id }, '关闭检查浏览器失败'),
        );
    },
  };
}

export type PreviewService = ReturnType<typeof createPreviewService>;
