// 节点出口的轻量关卡（ADR 0017）：只挡明显坏掉的成果，结果确定、不调模型。
// 1. 文件齐不齐：产出非空，方案写明的文件都在，数量和图片尺寸符合，文件能解析（inspector 的解析报告）。
// 2. 网页能不能打开：有 oasis-app.json 的成果在隔离浏览器里跑一遍（节点自己也能用 app.check 跑同一套）；
//    交给用户的网页没配 oasis-app.json 也算没满足（画布里不能运行、浏览器检查也跑不了）。
// 3. 音视频能不能播放：inspector 在不联网的检查容器里完整解码一遍，算力记在这个任务上。
// 任务单的「怎么算做好」由节点自己对照，不再交给模型逐条打分。检查程序本身出错记为没检查到，不冒充通过；
// 检查只提醒、不拦截（2026-11-05 用户决定）。
import { ApplicationCheckResult, OutputsLink, type RunOutputFile } from '@oasis/contracts/harness';
import {
  InspectedFiles,
  MEDIA_FILE,
  MediaCheckResult,
  type InspectedFile,
} from '@oasis/contracts/inspector';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { ExpectedFile } from '@oasis/contracts/task';
import type { z } from 'zod';
import type { CheckCompute } from './check-compute.ts';
import { patternRegExp } from './output-files.ts';

export interface GateResult {
  /** 没满足的地方（普通话，会原样交给节点去改、也会作为提醒给用户看）；为空表示通过 */
  unmet: string[];
  /** 检查程序本身没做完，不能冒充通过，也不因此重跑节点 */
  unchecked?: string[];
}

/** 网页应用的清单：放在应用目录里（root 相对 out/，不能是 out/ 本身） */
const APP_MANIFEST = /\/oasis-app\.json$/;

/** 连不上平台服务：用户看到的说法（2026-11-05 用户要求写清楚是网络问题） */
const NETWORK_TROUBLE = '连不上平台的检查服务（网络中断或超时）';

/** 检查中途出错的原因，说成用户看得懂的话 */
function troubleOf(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.code === 'provider_unavailable' || err.statusCode === 502 || err.statusCode === 504)
      return NETWORK_TROUBLE;
    if (err.statusCode === 503) return `${err.message}（服务暂时不可用）`;
    return err.message;
  }
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return NETWORK_TROUBLE;
  return err instanceof Error && err.message ? err.message : '检查程序出错';
}

/** 规则检查 */
export function checkRules(
  outputs: RunOutputFile[],
  expects: ExpectedFile[],
  inspected?: InspectedFile[],
): string[] {
  if (outputs.length === 0) return ['out/ 里没有任何产出文件'];
  const unmet: string[] = [];
  for (const expected of expects) {
    const pattern = typeof expected === 'string' ? expected : expected.pattern;
    const re = patternRegExp(pattern);
    const matched = outputs.filter((f) => re.test(f.path));
    if (typeof expected !== 'string') {
      if (!inspected) continue; // 内容尚未读取，不能提前下有效数量结论。
      const valid = matched.filter(
        (f) => f.size > 0 && inspected.some((i) => i.path === f.path && i.valid === true),
      );
      // 未支持的格式或遗漏的报告只能保留为未检查，不能据此断言文件损坏并重跑。
      const unknown = matched.filter((f) => {
        if (f.size === 0) return false;
        const report = inspected.find((i) => i.path === f.path);
        return (
          !report ||
          report.errorKind === 'incomplete' ||
          (!report.error &&
            (report.valid === undefined || (!report.valid && Boolean(report.warning))))
        );
      });
      const number = expected.exactCount ?? expected.minCount ?? 1;
      if (
        valid.length + unknown.length < number ||
        (expected.exactCount !== undefined && valid.length > number)
      )
        unmet.push(
          `out/${pattern} 有效文件 ${valid.length} 个，要求${expected.exactCount === undefined ? '至少' : '正好'} ${number} 个`,
        );
      if (expected.width || expected.height)
        for (const file of valid) {
          const image = inspected.find((f) => f.path === file.path)!;
          if (
            (expected.width && image.width !== expected.width) ||
            (expected.height && image.height !== expected.height)
          )
            unmet.push(
              `out/${file.path} 尺寸 ${image.width ?? '?'}×${image.height ?? '?'}，要求 ${expected.width ?? '不限'}×${expected.height ?? '不限'}`,
            );
        }
      continue;
    }
    if (matched.length === 0) unmet.push(`缺少文件 out/${pattern}`);
    else if (matched.every((f) => f.size === 0)) unmet.push(`文件 out/${pattern} 是空的`);
  }
  return [...new Set(unmet)];
}

/**
 * 交给用户的网页（子目录里的 .html）要配 oasis-app.json，否则画布里不能运行、浏览器检查也跑不了。
 * 2026-11-08 真模型回归：规划员有时没把清单写进节点要求，网页交付了，画布里却打不开。
 * 直接放在 out/ 下的 .html 不管：清单不能放在 out/ 本身，挪目录会和方案写的交付路径对不上。
 */
export function checkWebManifest(outputs: RunOutputFile[], deliver: readonly string[]): string[] {
  if (!deliver.length) return [];
  const delivered = deliver.map(patternRegExp);
  const roots = outputs
    .filter((f) => APP_MANIFEST.test(f.path))
    .map((f) => f.path.slice(0, -'/oasis-app.json'.length));
  const dirs = new Set(
    outputs
      .filter(
        (f) =>
          /\.html?$/i.test(f.path) &&
          f.path.includes('/') &&
          delivered.some((re) => re.test(f.path)) &&
          !roots.some((root) => f.path.startsWith(`${root}/`)),
      )
      .map((f) => f.path.slice(0, f.path.lastIndexOf('/'))),
  );
  // 同一个网页的子目录只报最外层那个
  const tops = [...dirs].filter((dir) => ![...dirs].some((other) => dir.startsWith(`${other}/`)));
  return tops.map(
    (dir) =>
      `交付的网页 out/${dir}/ 里没有 oasis-app.json：画布里不能直接运行，浏览器检查也跑不了。` +
      `在 out/${dir}/ 里加上 oasis-app.json（格式见 in/.oasis-formats.json），再用 oasis-tool app.check --dir out/${dir} 自查。`,
  );
}

interface GateInput {
  signal?: AbortSignal;
  payerId: string;
  taskId: string;
  nodeId: string;
  /** 这次交出产出的运行 */
  runId: string;
  outputs: RunOutputFile[];
  expects: ExpectedFile[];
  /** 交给用户的文件（方案里的 deliver） */
  deliver?: readonly string[];
}

/** 音视频交给解码检查（其余文件走文件解析）；提醒里按种类称呼 */
const isMedia = (path: string) => MEDIA_FILE.test(path);
const mediaLabel = (path: string) =>
  /\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(path) ? '音频' : '视频/工程/字幕';

/** 音视频的解码结果：数量按它算（并进文件解析报告），未满足和未检查照旧排在最后 */
interface MediaFindings {
  inspected: InspectedFile[];
  unmet: string[];
  unchecked: string[];
}

export function createGate(deps: {
  harness: ServiceClient;
  inspector: ServiceClient;
  /** 解码检查的算力：先冻结、按 inspector 报回的用量结算（ADR 0024） */
  compute: CheckCompute;
  /** 解码检查容器用几核、最多跑多久（这个任务付钱） */
  media: { cores: number; timeoutMs: number };
  logger: Logger;
}) {
  const { harness, inspector, compute, logger } = deps;
  const options = <T>(input: GateInput, body: unknown, schema: z.ZodType<T>) => ({
    body,
    schema,
    // 检查不设时限（2026-11-04 用户决定）：用户停止/取消节点时由 signal 断开
    timeoutMs: null,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  /** 这次运行的产出包：harness 签发临时下载链接，inspector 拿它去读（ADR 0024） */
  const outputsOf = (input: GateInput) =>
    harness.json(
      'POST',
      `/internal/runs/${input.runId}/outputs/link`,
      options(input, { payerId: input.payerId, taskId: input.taskId }, OutputsLink),
    );

  /** 文件能不能解析、数量和尺寸：inspector 的解析报告，不读正文 */
  async function checkFiles(
    input: GateInput,
    source: () => Promise<OutputsLink>,
    media: InspectedFile[],
    unmet: string[],
    unchecked: string[],
  ) {
    const paths = input.outputs.map((f) => f.path).filter((path) => !isMedia(path));
    const report = paths.length
      ? await inspector.json(
          'POST',
          '/internal/files/check',
          options(input, { source: await source(), paths, maxChars: 1 }, InspectedFiles),
        )
      : { files: [], truncated: false };
    for (const file of report.files)
      if (file.error && file.valid === false && file.errorKind !== 'incomplete')
        unmet.push(`${file.path}：${file.error}`);
    const inspected = [...report.files, ...media];
    unmet.push(
      ...checkRules(input.outputs, input.expects, inspected).filter((u) => !unmet.includes(u)),
    );
    for (const output of input.outputs)
      if (
        !inspected.some((f) => f.path === output.path) &&
        input.expects.some(
          (e) => typeof e !== 'string' && patternRegExp(e.pattern).test(output.path),
        )
      )
        unchecked.push(`${output.path}：没取得文件解析结果`);
  }

  async function checkApplication(input: GateInput, unmet: string[]) {
    const result = await harness.json(
      'POST',
      `/internal/runs/${input.runId}/application-check`,
      options(input, { payerId: input.payerId, taskId: input.taskId }, ApplicationCheckResult),
    );
    if (!result.passed) unmet.push(`浏览器实际运行检查失败：${result.reason ?? '原因未返回'}`);
  }

  /** 音视频、平台工程、字幕能不能完整解码：inspector 开检查容器做，算力按实际用时记在这个任务上 */
  async function checkMedia(
    input: GateInput,
    source: () => Promise<OutputsLink>,
    found: MediaFindings,
  ) {
    const media = input.outputs.filter((file) => isMedia(file.path));
    if (!media.length) return;
    const body = {
      source: await source(),
      paths: media.map((file) => file.path),
      cores: deps.media.cores,
      timeoutMs: deps.media.timeoutMs,
    };
    const result = await compute(
      input,
      // 容器开起来、脚本收尾要多一点时间
      { purpose: 'media-check', cores: body.cores, maxMs: body.timeoutMs + 30_000 },
      () => inspector.json('POST', '/internal/media/check', options(input, body, MediaCheckResult)),
    );
    for (const file of media) {
      const label = mediaLabel(file.path);
      const checked = result.files.find((item) => item.path === file.path);
      if (!checked) {
        found.unchecked.push(`${label}「${file.path}」未完成解码检查`);
        found.inspected.push({
          path: file.path,
          text: '',
          valid: false,
          warning: '媒体检查未完成',
        });
      } else {
        if (!checked.valid)
          found.unmet.push(`${label}「${file.path}」${checked.error ?? '探测或完整解码失败'}`);
        found.inspected.push({
          path: file.path,
          text: '',
          valid: checked.valid,
          ...(checked.error ? { error: checked.error } : {}),
        });
      }
    }
  }

  /** 检查程序本身出错：记为没检查到，不当成品失败打回重做 */
  async function guarded(
    input: GateInput,
    label: string,
    unchecked: string[],
    work: () => Promise<void>,
  ) {
    try {
      await work();
    } catch (err) {
      input.signal?.throwIfAborted();
      logger.warn({ err, taskId: input.taskId, runId: input.runId }, `${label}没做完`);
      unchecked.push(`${label}没做完：${troubleOf(err)}`);
    }
  }

  return {
    async check(input: GateInput): Promise<GateResult> {
      const unmet = checkRules(input.outputs, input.expects);
      // 连产出都不齐就不用往下查了
      if (unmet.length > 0) return { unmet };
      unmet.push(...checkWebManifest(input.outputs, input.deliver ?? []));
      const unchecked: string[] = [];
      // 产出包链接只要一次，文件解析和解码检查共用
      let link: Promise<OutputsLink> | undefined;
      const source = () => (link ??= outputsOf(input));
      const media: MediaFindings = { inspected: [], unmet: [], unchecked: [] };
      await guarded(input, '音视频解码检查', media.unchecked, () =>
        checkMedia(input, source, media),
      );
      await guarded(input, '文件解析检查', unchecked, () =>
        checkFiles(input, source, media.inspected, unmet, unchecked),
      );
      if (input.outputs.some((file) => APP_MANIFEST.test(file.path)))
        await guarded(input, '浏览器实际运行检查', unchecked, () => checkApplication(input, unmet));
      unmet.push(...media.unmet);
      unchecked.push(...media.unchecked);
      return { unmet, ...(unchecked.length ? { unchecked } : {}) };
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
