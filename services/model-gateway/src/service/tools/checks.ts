// 检查类工具：外站浏览器测试、网页应用自查（和交付关卡同一套浏览器检查）、Android 原生应用测试。
// 浏览器检查都在 inspector（ADR 0024）：网关转交参数，检查浏览器的算力由网关冻结、按 inspector 报回的
// 实际用时结算，记在调用的任务和节点上。
import { randomUUID } from 'node:crypto';
import {
  ApplicationCheckReply,
  WebsiteCheckReply,
  type ApplicationCheckResult,
  type ComputeUsage,
} from '@oasis/contracts/inspector';
import { WebsiteTestArgs } from '@oasis/contracts/ui-test';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { AndroidTestArgs } from '../../adapters/browserstack.ts';
import type { ToolDef, ToolDeps } from './kit.ts';

const AppCheckArgs = z.object({
  dir: z.string().min(1).max(220),
  /** 沙箱里的 oasis-tool 读好应用目录的文件一起带来（相对 dir 的路径） */
  files: z.array(z.object({ path: z.string(), contentBase64: z.string() })).optional(),
  /** 实际检查的目录在沙箱里的路径（out/site、in/<上游 key>/site），结果里照这个说；旧版沙箱不带 */
  shown: z.string().min(1).max(260).optional(),
  /** 调用时给了 --out：把完整报告作为文件交回，存进去给下游用 */
  report: z.boolean().optional(),
});

/** 检查浏览器的算力：先冻结，按 inspector 报回的实际用时结算；检查没做完不收钱 */
async function metered<T extends { usage: ComputeUsage }>(
  deps: ToolDeps,
  work: (cores: number) => Promise<T>,
): Promise<T> {
  const { compute, cores, maxMs } = deps.checks!;
  const id = randomUUID();
  const hold = await compute.hold({
    runId: id,
    payerId: deps.payerId!,
    taskId: deps.taskId ?? null,
    nodeId: deps.nodeId ?? null,
    cores,
    maxMs,
    purpose: 'application-check',
    requestId: id,
  });
  let usage: ComputeUsage = { cores, elapsedMs: 0 };
  try {
    const result = await work(cores);
    usage = { cores: result.usage.cores, elapsedMs: Math.min(maxMs, result.usage.elapsedMs) };
    return result;
  } finally {
    if (hold.callId)
      await compute
        .settle(hold.callId, usage)
        .catch((err: unknown) =>
          deps.logger?.warn({ err, callId: hold.callId }, '检查算力没结算上，冻结到期会自动退回'),
        );
  }
}

/** app.check 的结果说成节点能直接照着改的话：原因、页面报错、没覆盖到的地方 */
function appCheckText(shown: string, result: ApplicationCheckResult): string {
  const report = result.report;
  const lines = [
    result.passed
      ? `${shown}：浏览器检查通过（交付后关卡复跑的是同一套检查）。`
      : `${shown}：浏览器检查没通过：${result.reason ?? '原因未返回'}`,
    ...(report?.steps ?? [])
      .filter((step) => step.status === 'failed')
      .map((step) => `- 第 ${step.index + 1} 步 ${step.action}：${step.error ?? '未通过'}`),
    ...(report?.unchecked ?? []).map((item) => `- 没检查到：${item}`),
  ];
  return lines.join('\n');
}

export const websiteTest: ToolDef = {
  key: 'website.test',
  name: '外站浏览器测试',
  description: '在禁网容器测试配置放行的外部 HTTPS 网站，返回断言和截图。仅 GET/HEAD。',
  usage:
    '传 url 和 plan，plan 使用 {version:1,steps:[{action:"visible",selector:"h1"},{action:"screenshot"}]}；来源须由管理员提前放行。',
  unit: '次（算力单独结算）',
  estimateMicro: 0,
  holdMicro: () => 1,
  provider: 'inspector',
  models: () => ['oasis/browser'],
  modelOf: () => 'oasis/browser',
  args: WebsiteTestArgs,
  cli: [
    { name: 'url', kind: 'text', required: true, description: '要测的 HTTPS 网址（须已放行）' },
    { name: 'plan', kind: 'json', required: true, description: '测试步骤 {version:1,steps:[…]}' },
  ],
  long: false,
  run: async (deps, args) => {
    if (!deps.taskId) throw new HttpError(400, 'task_required', '网站测试需要所属任务');
    const result = await metered(deps, async (cores) => {
      const response = await deps.upstream(() =>
        deps.checks!.inspector.stream('POST', '/internal/websites/check', {
          body: { ...args, cores },
          signal: deps.signal,
        }),
      );
      return WebsiteCheckReply.parse(await response.json());
    });
    return {
      text: result.report.passed
        ? '外站声明式测试步骤通过；覆盖限制见报告。'
        : '外站测试未通过，请查看报告。',
      data: result.report,
      files: [
        {
          name: 'website-check.json',
          mediaType: 'application/json',
          base64: Buffer.from(JSON.stringify(result.report)).toString('base64'),
        },
        ...result.screenshots.map((file) => ({ ...file, mediaType: 'image/jpeg' })),
      ],
      cost: { costMicro: 0, source: 'provider' },
    };
  },
};

export const appCheck: ToolDef = {
  key: 'app.check',
  name: '网页应用自查',
  description:
    '把网页应用（带 oasis-app.json；自己 out/ 里的，或上游交来的 in/<上游 key>/ 里的）放进和交付检查同一个隔离浏览器里打开，按 oasis-test.json 操作，当场返回页面报错和没通过的步骤；给了 --out 就把完整报告（JSON）存进去，平台截的画面（打开后的首屏 opening.jpg、测试里 screenshot 步骤和没通过那一步的截图）存在报告旁边，名字是「报告名-截图名」。',
  usage:
    'oasis-tool app.check --dir out/site [--out out/检查报告.json]（--dir 是 oasis-app.json 所在目录；上游交来的写 in/<上游 key>/site）',
  unit: '次（算力单独结算）',
  estimateMicro: 0,
  holdMicro: () => 1,
  provider: 'inspector',
  models: () => ['oasis/browser'],
  modelOf: () => 'oasis/browser',
  args: AppCheckArgs,
  cli: [
    {
      name: 'dir',
      kind: 'dir',
      required: true,
      description: 'oasis-app.json 所在目录：自己做的如 out/site，上游交来的如 in/<上游 key>/site',
    },
  ],
  long: false,
  run: async (deps, args) => {
    if (!deps.taskId) throw new HttpError(400, 'task_required', '网页应用自查只能在任务节点里用');
    const parsed = AppCheckArgs.parse(args);
    const dir = parsed.dir.replace(/^(\.\/)?(\/workspace\/)?(out\/)?/, '').replace(/\/+$/, '');
    if (!dir)
      throw new HttpError(400, 'invalid_args', '--dir 写 oasis-app.json 所在的目录，如 out/site');
    // 文件由沙箱里的 oasis-tool 读好带来；旧版沙箱镜像不带
    if (!parsed.files)
      throw new HttpError(
        400,
        'sandbox_outdated',
        'oasis-tool 版本过旧，没有带上 out/ 里的文件，app.check 用不了（沙箱镜像需要重建：pnpm sandbox:build）。这次先跳过自查，交付后关卡照常检查。',
      );
    const shown = parsed.shown ?? `out/${dir}`;
    if (!parsed.files.length) throw new HttpError(400, 'invalid_args', `${shown} 里没有文件`);
    const result = await metered(deps, async (cores) => {
      const response = await deps.upstream(() =>
        deps.checks!.inspector.stream('POST', '/internal/applications/check-files', {
          // 给了 --out：除了报告，平台截的画面也要回来，存在报告旁边给节点看
          body: {
            dir,
            files: parsed.files,
            cores,
            ...(parsed.report ? { screenshots: true } : {}),
          },
          // 页面多慢都等（与关卡一致），调用方中断时随之回收浏览器
          signal: deps.signal,
        }),
      );
      return ApplicationCheckReply.parse(await response.json());
    });
    return {
      text: appCheckText(shown, result),
      data: result.report ?? null,
      // 调用时给了 --out（工具节点把检查结果交给下游）：完整报告作为文件交回，沙箱存到 --out
      files: parsed.report
        ? [
            {
              name: 'app-check.json',
              mediaType: 'application/json',
              base64: Buffer.from(
                JSON.stringify({
                  dir: shown,
                  passed: result.passed,
                  ...(result.reason ? { reason: result.reason } : {}),
                  report: result.report ?? null,
                }),
              ).toString('base64'),
            },
            ...(result.screenshots ?? []).map((shot) => ({
              name: shot.name,
              mediaType: 'image/jpeg',
              base64: shot.base64,
            })),
          ]
        : [],
      cost: { costMicro: 0, source: 'provider' },
    };
  },
};

export const androidTest: ToolDef = {
  key: 'android.test',
  name: 'Android 原生应用测试',
  description: '在真实云 Android 设备运行已上传 APK 的声明式测试，保存步骤报告和截图；仅免费计划。',
  usage:
    '传 uploadId、device、osVersion 和 steps（click/fill/visible/text/screenshot）。selector 使用 {using:"id"|"accessibility id"|"xpath",value:"…"}。最多 10 步，不支持任意脚本。',
  unit: '次',
  estimateMicro: 0,
  holdMicro: () => 1,
  provider: 'browserstack',
  models: () => ['browserstack/android-free'],
  modelOf: () => 'browserstack/android-free',
  args: AndroidTestArgs,
  cli: [
    { name: 'uploadId', kind: 'text', required: true, description: '已上传 APK 的 uploadId' },
    { name: 'device', kind: 'text', required: true, description: '设备型号' },
    { name: 'osVersion', kind: 'text', required: true, description: 'Android 版本' },
    { name: 'steps', kind: 'json', required: true, description: '最多 10 步的声明式测试' },
  ],
  long: true,
  start: (deps, args) => deps.browserstack!.start(args, deps.payerId!, deps.signal),
  check: (deps, id) => deps.browserstack!.check(id, deps.receipt!, deps.signal),
  cancel: async (deps, id) => {
    await deps.browserstack!.check(id, deps.receipt!, deps.signal, true);
  },
};
