// 检查类工具：外站浏览器测试、网页应用自查（和交付关卡同一套浏览器检查）、Android 原生应用测试。
import { ApplicationCheckResult } from '@oasis/contracts/harness';
import { BrowserTestResult, WebsiteTestArgs } from '@oasis/contracts/ui-test';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import { AndroidTestArgs } from '../../adapters/browserstack.ts';
import type { ToolDef } from './kit.ts';

const AppCheckArgs = z.object({ dir: z.string().min(1).max(220) });

/** app.check 的结果说成节点能直接照着改的话：原因、页面报错、没覆盖到的地方 */
function appCheckText(dir: string, result: ApplicationCheckResult): string {
  const report = result.report;
  const lines = [
    result.passed
      ? `out/${dir}：浏览器检查通过（交付后关卡复跑的是同一套检查）。`
      : `out/${dir}：浏览器检查没通过：${result.reason ?? '原因未返回'}`,
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
  provider: 'harness',
  models: () => ['oasis/browser'],
  modelOf: () => 'oasis/browser',
  args: WebsiteTestArgs,
  long: false,
  run: async (deps, args) => {
    if (!deps.taskId) throw new HttpError(400, 'task_required', '网站测试需要所属任务');
    const response = await deps.upstream(() =>
      deps.harness!.stream('POST', '/internal/websites/check', {
        body: { ...args, payerId: deps.payerId, taskId: deps.taskId },
        signal: deps.signal,
      }),
    );
    const result = BrowserTestResult.parse(await response.json());
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
    '把 out/ 里的网页应用（带 oasis-app.json）放进和交付检查同一个隔离浏览器里打开，按 oasis-test.json 操作，当场返回页面报错和没通过的步骤。',
  usage: 'oasis-tool app.check --dir out/site（--dir 是 oasis-app.json 所在目录）',
  unit: '次（算力单独结算）',
  estimateMicro: 0,
  holdMicro: () => 1,
  provider: 'harness',
  models: () => ['oasis/browser'],
  modelOf: () => 'oasis/browser',
  args: AppCheckArgs,
  long: false,
  run: async (deps, args) => {
    if (!deps.taskId || !deps.runId)
      throw new HttpError(400, 'run_required', '网页应用自查只能在任务节点里用');
    const dir = AppCheckArgs.parse(args)
      .dir.replace(/^(\.\/)?(\/workspace\/)?(out\/)?/, '')
      .replace(/\/+$/, '');
    if (!dir)
      throw new HttpError(400, 'invalid_args', '--dir 写 oasis-app.json 所在的目录，如 out/site');
    const response = await deps.upstream(() =>
      deps.harness!.stream('POST', `/internal/runs/${deps.runId}/application-check/live`, {
        body: { payerId: deps.payerId, taskId: deps.taskId, dir },
        // 页面多慢都等（与关卡一致），调用方中断时随之回收浏览器
        timeoutMs: null,
        signal: deps.signal,
      }),
    );
    const result = ApplicationCheckResult.parse(await response.json());
    return {
      text: appCheckText(dir, result),
      data: result.report ?? null,
      files: [],
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
  long: true,
  start: (deps, args) => deps.browserstack!.start(args, deps.payerId!, deps.signal),
  check: (deps, id) => deps.browserstack!.check(id, deps.receipt!, deps.signal),
  cancel: async (deps, id) => {
    await deps.browserstack!.check(id, deps.receipt!, deps.signal, true);
  },
};
