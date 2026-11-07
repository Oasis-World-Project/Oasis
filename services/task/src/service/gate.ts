// 节点出口的轻量关卡（ADR 0017）：只挡明显坏掉的成果，结果确定、不调模型。
// 1. 文件齐不齐：产出非空，方案写明的文件都在，数量和图片尺寸符合，文件能解析（harness 的解析报告）。
// 2. 网页能不能打开：有 oasis-app.json 的成果在隔离浏览器里跑一遍（节点自己也能用 app.check 跑同一套）。
// 3. 音视频能不能播放：完整解码一遍。
// 任务单的「怎么算做好」由节点自己对照，不再交给模型逐条打分。检查程序本身出错记为没检查到，不冒充通过；
// 检查只提醒、不拦截（2026-11-05 用户决定）。
import {
  AudioCheckResult,
  VideoCheckResult,
  ApplicationCheckResult,
  RunTextsBody,
  type RunOutputFile,
} from '@oasis/contracts/harness';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { ExpectedFile } from '@oasis/contracts/task';
import type { z } from 'zod';
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
  inspected?: RunTextsBody['files'],
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

interface GateInput {
  signal?: AbortSignal;
  payerId: string;
  taskId: string;
  nodeId: string;
  /** 这次交出产出的运行 */
  runId: string;
  outputs: RunOutputFile[];
  expects: ExpectedFile[];
}

const MEDIA = [
  {
    name: 'audio',
    label: '音频',
    pattern: /\.(wav|mp3|m4a|flac|ogg|aac)$/i,
    schema: AudioCheckResult,
  },
  {
    name: 'video',
    label: '视频/工程/字幕',
    pattern: /\.(mp4|mov|mkv|avi|webm|mlt|srt)$/i,
    schema: VideoCheckResult,
  },
] as const;

export function createGate(deps: { harness: ServiceClient; logger: Logger }) {
  const { harness, logger } = deps;
  const call = <T>(input: GateInput, path: string, body: unknown, schema: z.ZodType<T>) =>
    harness.json('POST', path, {
      body,
      schema,
      // 检查不设时限（2026-11-04 用户决定）：用户停止/取消节点时由 signal 断开
      timeoutMs: null,
      ...(input.signal ? { signal: input.signal } : {}),
    });

  /** 文件能不能解析、数量和尺寸：harness 的解析报告，不读正文 */
  async function checkFiles(input: GateInput, unmet: string[], unchecked: string[]) {
    const report = await call(
      input,
      `/internal/runs/${input.runId}/texts`,
      { paths: input.outputs.map((f) => f.path), maxChars: 1 },
      RunTextsBody,
    );
    for (const file of report.files)
      if (file.error && file.valid === false && file.errorKind !== 'incomplete')
        unmet.push(`${file.path}：${file.error}`);
    unmet.push(
      ...checkRules(input.outputs, input.expects, report.files).filter((u) => !unmet.includes(u)),
    );
    for (const output of input.outputs)
      if (
        !report.files.some((f) => f.path === output.path) &&
        input.expects.some(
          (e) => typeof e !== 'string' && patternRegExp(e.pattern).test(output.path),
        )
      )
        unchecked.push(`${output.path}：没取得文件解析结果`);
  }

  async function checkApplication(input: GateInput, unmet: string[]) {
    const result = await call(
      input,
      `/internal/runs/${input.runId}/application-check`,
      { payerId: input.payerId, taskId: input.taskId },
      ApplicationCheckResult,
    );
    if (!result.passed) unmet.push(`浏览器实际运行检查失败：${result.reason ?? '原因未返回'}`);
  }

  async function checkMedia(
    input: GateInput,
    kind: (typeof MEDIA)[number],
    unmet: string[],
    unchecked: string[],
  ) {
    const media = input.outputs.filter((file) => kind.pattern.test(file.path));
    if (!media.length) return;
    const result = await call(
      input,
      `/internal/runs/${input.runId}/${kind.name}-check`,
      { payerId: input.payerId, taskId: input.taskId },
      kind.schema,
    );
    for (const file of media) {
      const checked = result.files.find((item) => item.path === file.path);
      if (!checked) unchecked.push(`${kind.label}「${file.path}」未完成解码检查`);
      else if (!checked.valid)
        unmet.push(`${kind.label}「${file.path}」${checked.error ?? '探测或完整解码失败'}`);
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
      const unchecked: string[] = [];
      await guarded(input, '文件解析检查', unchecked, () => checkFiles(input, unmet, unchecked));
      if (input.outputs.some((file) => APP_MANIFEST.test(file.path)))
        await guarded(input, '浏览器实际运行检查', unchecked, () => checkApplication(input, unmet));
      for (const kind of MEDIA)
        await guarded(input, `${kind.label}解码检查`, unchecked, () =>
          checkMedia(input, kind, unmet, unchecked),
        );
      return { unmet, ...(unchecked.length ? { unchecked } : {}) };
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
