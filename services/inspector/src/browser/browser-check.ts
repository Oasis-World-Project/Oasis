// 网页的浏览器检查（ADR 0017、0021、0024）：交付关卡、节点自查（app.check）、外站测试共用。
// 每次检查开一个检查浏览器容器，用完即删；不设时限（2026-11-04 用户决定）：页面多慢都等，由控制端按页面
// 是否安定下结论，只有得出结果、浏览器进程退出或调用方断开（用户停止、取消节点）时才结束。
// inspector 不存东西：交付关卡的报告由 task 存回 harness；核数由付费的调用方定，实际用时报回去由它结算。
import { randomUUID } from 'node:crypto';
import type {
  ApplicationCheckBody,
  ApplicationCheckReply,
  ApplicationFilesCheckBody,
  ComputeUsage,
  WebsiteCheckBody,
  WebsiteCheckReply,
} from '@oasis/contracts/inspector';
import type { ApplicationBundle } from '@oasis/contracts/canvas';
import { BrowserTestPlan, type BrowserTestResult } from '@oasis/contracts/ui-test';
import { HttpError, readLimited, scanArchive } from '@oasis/service-kit';
import { createQueue } from '../service/queue.ts';
import type { Sources } from '../service/sources.ts';
import { assemble, fail, failureReason, type Failure } from './application-bundle.ts';
import type { BrowserBox, BrowserExecutor } from './executor.ts';
import { createWebsiteFetch, websiteUrl } from './website-fetch.ts';

/** 应用文件加起来的上限（和画布登记应用的上限一致） */
const APP_MAX_BYTES = 100 * 1024 * 1024;
/** 页面自己的问题（应用没起来、首页打不开）：如实算没通过，不算检查程序出错 */
const PAGE_TROUBLE = /应用没有在回环地址|首页返回|net::ERR_/;

/** 浏览器开过、检查做完的结果：页面报告、步骤截图、首屏 */
interface Browsed {
  report: BrowserTestResult['report'];
  steps: BrowserTestResult['screenshots'];
  opening?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBrowserChecks(deps: {
  executor: BrowserExecutor;
  sources: Sources;
  /** 外站测试放行的 HTTPS 来源 */
  websiteOrigins: string[];
  /** 运行产出包的大小上限 */
  maxArchiveBytes: number;
  /** 同时最多开几个检查浏览器 */
  concurrency: number;
}) {
  const queue = createQueue(deps.concurrency);

  /** 开一个检查浏览器做 work，用完即删；页面自己的问题返回没通过，检查程序出错抛出 */
  async function opened<T>(
    spec: Parameters<BrowserExecutor['start']>[0],
    signal: AbortSignal | undefined,
    work: (box: BrowserBox) => Promise<T>,
  ): Promise<{ outcome: T | Failure; usage: ComputeUsage }> {
    try {
      await deps.executor.check();
    } catch (err) {
      throw new HttpError(
        503,
        'browser_unavailable',
        err instanceof Error ? err.message : '检查浏览器用不了',
      );
    }
    signal?.throwIfAborted();
    const started = Date.now();
    const usage = () => ({ cores: spec.cores, elapsedMs: Date.now() - started });
    const box = await deps.executor.start(spec);
    const stop = () => void box.destroy().catch(() => undefined);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await box.ready();
      return { outcome: await work(box), usage: usage() };
    } catch (err) {
      if (signal?.aborted) throw new HttpError(499, 'check_aborted', '检查已被停止');
      if (err instanceof Error && PAGE_TROUBLE.test(err.message))
        return { outcome: fail(err.message), usage: usage() };
      throw err;
    } finally {
      signal?.removeEventListener('abort', stop);
      await box.destroy().catch(() => undefined);
    }
  }

  /** 在检查浏览器里打开网页包、按测试计划操作、看画面 */
  async function browse(
    bundle: ApplicationBundle,
    plan: BrowserTestPlan | undefined,
    cores: number,
    signal?: AbortSignal,
  ) {
    const files = bundle.files.map((file) => ({
      path: file.path,
      content: Buffer.from(file.contentBase64, 'base64'),
    }));
    const size = files.reduce((sum, file) => sum + file.content.length, 0);
    if (size > APP_MAX_BYTES || !files.some((file) => file.path === bundle.spec.entry))
      throw new HttpError(422, 'application_invalid', '应用入口或文件大小不合格');
    const spec = {
      id: randomUUID(),
      cores,
      kind: bundle.spec.kind,
      entry: bundle.spec.entry,
      files,
    };
    return opened(spec, signal, async (box): Promise<Browsed> => {
      let opening: { jpegBase64: string } | undefined;
      while (!opening) {
        signal?.throwIfAborted();
        // 检查程序自己的浏览器没了：这是检查未完成，不是成品失败
        if (!box.alive())
          throw new HttpError(503, 'check_incomplete', '检查用的浏览器进程提前结束，没有生成画面');
        opening = box.frame();
        if (!opening) await sleep(200);
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
    });
  }

  /**
   * 读运行产出包：清单所在目录里的文件读进内存（组装运行包用），其余只记路径和大小
   * （放错目录的测试计划要能认出来）。应用目录超过上限时照常返回，由组装报不合格。
   */
  async function readOutputs(url: string, manifest: string, signal?: AbortSignal) {
    const root = manifest.slice(0, -'/oasis-app.json'.length);
    // 清单和测试计划很小，应用目录超限时也读进来，好说清楚是哪里不合格
    const small = new Set([manifest, `${root}/oasis-test.json`]);
    const kept = new Map<string, Buffer>();
    let total = 0;
    const list = await scanArchive(
      await deps.sources.open(url, signal),
      deps.maxArchiveBytes,
      async (path, size, stream) => {
        if (!path.startsWith(`${root}/`)) return;
        total += size;
        if (total <= APP_MAX_BYTES || (small.has(path) && size <= 1024 * 1024))
          kept.set(path, await readLimited(stream, APP_MAX_BYTES));
      },
    );
    return {
      list: list.map(({ path, size }) => ({ path, size })),
      read: async (path: string) => {
        const content = kept.get(path);
        if (!content)
          throw new HttpError(422, 'application_invalid', '应用文件数量、大小或入口不合格');
        return content;
      },
    };
  }

  /** 组装好的运行包跑一遍，说成关卡和节点看得懂的结论 */
  async function conclude(
    prepared: Exclude<Awaited<ReturnType<typeof assemble>>, Failure>,
    cores: number,
    signal: AbortSignal | undefined,
    keep: boolean,
    shots = keep,
  ): Promise<ApplicationCheckReply> {
    const { outcome, usage } = await browse(prepared.bundle, prepared.plan, cores, signal);
    if (!('report' in outcome)) return { ...outcome, usage };
    return {
      passed: outcome.report.passed,
      reason: outcome.report.passed ? null : failureReason(outcome.report),
      frameCaptured: true,
      report: outcome.report,
      // 交付关卡留档：绑定实际检查的运行包
      ...(keep ? { application: prepared.application, inputSha256: prepared.inputSha256 } : {}),
      // 平台截的画面：关卡留档时带上；节点自查要看画面时（shots）也带上，不要就只给结论
      ...(shots
        ? {
            screenshots: [
              ...(outcome.opening ? [{ name: 'opening.jpg', base64: outcome.opening }] : []),
              ...outcome.steps,
            ],
          }
        : {}),
      usage,
    };
  }

  /** 没开浏览器就有结论（清单、入口、测试计划不合格） */
  const unopened = (failure: Failure, cores: number): ApplicationCheckReply => ({
    ...failure,
    usage: { cores, elapsedMs: 0 },
  });

  return {
    /** 交付关卡：检查运行产出包里这份清单所在的应用；结论交回 task 留档 */
    checkOutputs: (body: ApplicationCheckBody, signal?: AbortSignal) =>
      queue(async () => {
        const outputs = await readOutputs(body.source.url, body.manifest, signal);
        if (!outputs.list.some((file) => file.path === body.manifest))
          throw new HttpError(422, 'manifest_missing', '产出包里没有这份应用清单');
        const prepared = await assemble(body.manifest, outputs.list, outputs.read);
        if ('reason' in prepared) return unopened(prepared, body.cores);
        return conclude(prepared, body.cores, signal, true);
      }, signal),

    /** 节点自查（app.check）：out/<dir> 的当前文件随调用带来，不留档，结论当场交回节点 */
    checkFiles: (body: ApplicationFilesCheckBody, signal?: AbortSignal) =>
      queue(async () => {
        const files = new Map(
          body.files.map((file) => [
            `${body.dir}/${file.path}`,
            Buffer.from(file.contentBase64, 'base64'),
          ]),
        );
        const manifest = `${body.dir}/oasis-app.json`;
        if (!files.has(manifest))
          return unopened(
            fail(`out/${body.dir} 里没有 oasis-app.json；实际契约见 in/.oasis-formats.json`),
            body.cores,
          );
        const prepared = await assemble(
          manifest,
          [...files].map(([path, content]) => ({ path, size: content.length })),
          async (path) => files.get(path)!,
        );
        if ('reason' in prepared) return unopened(prepared, body.cores);
        return conclude(prepared, body.cores, signal, false, body.screenshots === true);
      }, signal),

    /** 外站测试（website.test）：只按测试计划访问放行来源的 HTTPS 页面 */
    checkWebsite: (body: WebsiteCheckBody, signal?: AbortSignal) =>
      queue(async (): Promise<WebsiteCheckReply> => {
        try {
          websiteUrl(body.url, deps.websiteOrigins);
        } catch (err) {
          throw new HttpError(
            400,
            'website_not_allowed',
            err instanceof Error ? err.message : '这个网址没有放行',
          );
        }
        const plan = BrowserTestPlan.parse(body.plan);
        const spec = {
          id: randomUUID(),
          cores: body.cores,
          kind: 'website' as const,
          entry: 'index.html',
          files: [{ path: 'index.html', content: Buffer.from(' ') }],
          website: { url: body.url, fetch: createWebsiteFetch(deps.websiteOrigins) },
        };
        const { outcome, usage } = await opened(spec, signal, async (box) => {
          const result = await box.test(plan);
          result.report.diagnostics = box.diagnostics();
          if (result.report.diagnostics.length) result.report.passed = false;
          result.report.unchecked.push(
            '仅测试放行来源的 HTTPS GET/HEAD；登录、写请求、WebSocket 和 IPv6 未检查',
          );
          return result;
        });
        if (!('report' in outcome)) throw new HttpError(422, 'website_failed', outcome.reason);
        return { ...outcome, usage };
      }, signal),
  };
}

export type BrowserChecks = ReturnType<typeof createBrowserChecks>;
