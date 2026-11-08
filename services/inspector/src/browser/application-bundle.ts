// 按清单把节点交出的网页组装成检查用的运行包（ADR 0021）：静态网页按画布的方式打开（同一份 live-page 规则），
// 画布里加载不了的文件、清单和测试计划的问题在启动浏览器前就说清楚，交给节点修复。
import { createHash } from 'node:crypto';
import { LIVE_SANDBOX, livePage } from '@oasis/live-page';
import { ApplicationBundle, ApplicationSpec } from '@oasis/contracts/canvas';
import { BrowserTestPlan, type BrowserTestResult } from '@oasis/contracts/ui-test';

/** 画布运行网页的规则，交给节点看（没过时写进原因） */
const CANVAS_RULE =
  '画布把网页放进不联网的隔离框运行：<script>/<link>/<img> 和 ES 模块 import（含 importmap）引用同目录文件可以；' +
  'fetch/XHR 读本地文件、CDN、localStorage 不行，模型等数据请内嵌成 data: 地址或 JS 里的常量。';

/** 浏览器检查没过时说清楚哪一步、为什么，以及页面自己报的错（交给节点修复，也给用户看） */
export function failureReason(report: BrowserTestResult['report']): string {
  const failed = report.steps.filter((step) => step.status === 'failed');
  const parts = [
    ...failed.map((step) => step.error ?? `第 ${step.index + 1} 步 ${step.action} 未通过`),
    ...report.diagnostics.map((message) => `页面诊断：${message}`),
  ];
  return parts.length ? parts.join('；') : '浏览器交互断言或页面诊断未通过';
}

export type Failure = { passed: false; reason: string; frameCaptured: false };
export const fail = (reason: string): Failure => ({ passed: false, reason, frameCaptured: false });

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
export async function assemble(
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
