// 节点出口的轻量关卡（ADR 0004 §2，参考 dsh 的门控设计：能用规则判断的用代码，需要语义判断时才问 Jev）。
// 1. 规则检查（不花钱）：out/ 里有产出；方案里写明的文件都在且不是空的。
// 2. 验收点检查（Jev，几乎不花钱）：每条验收点问一个「是否满足」，概率低于阈值算没满足。
// 检查本身出错（Jev 连不上等）就放行，不卡用户。
import {
  AudioCheckResult,
  VideoCheckResult,
  ApplicationCheckResult,
  RunTextsBody,
  type RunOutputFile,
} from '@oasis/contracts/harness';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { ExpectedFile } from '@oasis/contracts/task';
import { patternRegExp } from './output-files.ts';

export interface GateResult {
  /** 没满足的地方（普通话，会原样交给节点去改、也会作为提醒给用户看）；为空表示通过 */
  unmet: string[];
  /** 检查异常或覆盖不足，不能冒充通过，也不因此重跑节点。 */
  unchecked?: string[];
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
  return unmet;
}

const DecisionAnswers = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().optional() }).loose()),
});

/** 要检查的一次运行：交付时说的话和产出；label 是给 Jev 看的名字（如交付物名） */
interface GateRun {
  runId: string;
  summary: string | null;
  outputs: RunOutputFile[];
  label?: string;
}

interface GateInput {
  payerId: string;
  taskId: string;
  /** 整体验收时为 null */
  nodeId: string | null;
  goal: string;
  runs: GateRun[];
  checks: string[];
  expects: ExpectedFile[];
}

export function createGate(deps: {
  harness: ServiceClient;
  modelGateway: ServiceClient;
  /** 判断验收点用的决策模型，如 typesafe/jev-1.14 */
  model: string;
  /** 「满足」的概率低于这个值就算没满足 */
  threshold: number;
  logger: Logger;
  visionMaxImages?: number;
  visionMaxBytes?: number;
  textMaxChars?: number;
}) {
  const { harness, modelGateway, logger } = deps;

  /** 验收点检查：把要做的事、交付时说的话和文字产出交给 Jev，每条验收点一个问题 */
  async function checkPoints(input: GateInput): Promise<GateResult> {
    // 只读取调用方已选出的文件，总正文额度按运行分配。
    const runs: GateRun[] = [];
    for (const run of input.runs) {
      const prior = runs.find((r) => r.runId === run.runId);
      if (!prior) runs.push({ ...run, outputs: [...run.outputs] });
      else {
        prior.outputs.push(
          ...run.outputs.filter((f) => !prior.outputs.some((p) => p.path === f.path)),
        );
        prior.label = [prior.label, run.label].filter(Boolean).join('、');
      }
    }
    const perRun = Math.max(
      1,
      Math.floor((deps.textMaxChars ?? 50_000) / Math.max(1, runs.length)),
    );
    const state = [`要做的事：${input.goal}`];
    const unchecked: string[] = [];
    const unmet: string[] = [];
    const vision: { runId: string; path: string }[] = [];
    for (const run of runs) {
      const texts = await harness.json('POST', `/internal/runs/${run.runId}/texts`, {
        body: { paths: run.outputs.map((file) => file.path), maxChars: perRun },
        schema: RunTextsBody,
      });
      const who = run.label ? `「${run.label}」` : '';
      const selected = texts.files.filter((f) => run.outputs.some((o) => o.path === f.path));
      if (texts.truncated) unchecked.push(`${who}文件内容或解析范围有截断，未覆盖全部内容`);
      for (const file of selected) {
        if (file.error || file.warning)
          unchecked.push(`${file.path}：${file.error ?? file.warning}`);
      }
      for (const output of run.outputs)
        if (!selected.some((f) => f.path === output.path))
          unchecked.push(`${output.path}：未取得内容检查结果`);
      unmet.push(
        ...checkRules(run.outputs, input.expects, selected).filter((u) => !unmet.includes(u)),
      );
      vision.push(
        ...run.outputs
          .filter(
            (f) =>
              /\.(png|jpe?g|webp)$/i.test(f.path) &&
              selected.some((s) => s.path === f.path && s.valid === true),
          )
          .map((f) => ({ runId: run.runId, path: f.path })),
      );
      state.push(
        `${who}交付时说：${run.summary ?? '（没说）'}`,
        `${who}产出文件：${run.outputs.map((f) => f.path).join('、')}`,
        ...selected.map(
          (f) => `文件 ${f.path} 的内容：\n${f.text}${f.error ? `\n未读到：${f.error}` : ''}`,
        ),
      );
    }
    if (unmet.length || !input.checks.length)
      return { unmet, ...(unchecked.length ? { unchecked } : {}) };
    const count = deps.visionMaxImages ?? 4;
    if (vision.length > count)
      unchecked.push(
        `视觉抽样仅覆盖 ${count}/${vision.length} 张：${vision
          .slice(0, count)
          .map((f) => f.path)
          .join('、')}`,
      );
    if (vision.length && input.checks.length) {
      try {
        const images = [];
        let bytes = 0;
        for (const file of vision.slice(0, count)) {
          const response = await harness.stream(
            'GET',
            `/internal/runs/${file.runId}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`,
          );
          const content = Buffer.from(await response.arrayBuffer());
          bytes += content.length;
          if (bytes > (deps.visionMaxBytes ?? 20 * 1024 * 1024))
            throw new Error('图片总大小超过视觉检查上限');
          const mediaType = /\.png$/i.test(file.path)
            ? 'image/png'
            : /\.webp$/i.test(file.path)
              ? 'image/webp'
              : 'image/jpeg';
          images.push({ mediaType, base64: content.toString('base64') });
        }
        const result = await modelGateway.json('POST', '/internal/v1/tools/image.inspect', {
          body: {
            args: {
              images,
              question: `逐张描述画面及可见文字，不能看清的明确说明。关注这些要求：${input.checks.join('；')}`,
            },
          },
          headers: {
            [OASIS_HEADERS.payerId]: input.payerId,
            [OASIS_HEADERS.taskId]: input.taskId,
            ...(input.nodeId ? { [OASIS_HEADERS.nodeId]: input.nodeId } : {}),
          },
          schema: z.object({ text: z.string() }),
        });
        state.push(
          `图片顺序：${vision
            .slice(0, count)
            .map((f) => f.path)
            .join('、')}\n视觉检查：${result.text}`,
        );
      } catch (err) {
        logger.warn({ err, taskId: input.taskId }, '视觉检查未完成');
        unchecked.push('视觉检查未完成，不能据节点说明确认画面满足要求');
      }
    }
    // 二元问题会把「看不出满足」判成失败；覆盖不足只能报告未检查，不能因此重做。
    if (unchecked.length) return { unmet: [], unchecked };
    const questions = Object.fromEntries(
      input.checks.map((check, i) => [
        `c${i}`,
        {
          type: 'noul',
          instructions: `这份产出是否满足这条要求：${check}`,
          criteria: { true: '满足这条要求', false: '不满足，或者从产出里看不出满足' },
        },
      ]),
    );
    const { answers } = await modelGateway.json('POST', '/internal/v1/decisions', {
      body: { model: deps.model, state, questions },
      // 花费记在付费人账上，并计入这个任务（和节点）
      headers: {
        [OASIS_HEADERS.payerId]: input.payerId,
        [OASIS_HEADERS.taskId]: input.taskId,
        ...(input.nodeId ? { [OASIS_HEADERS.nodeId]: input.nodeId } : {}),
      },
      schema: DecisionAnswers,
    });
    input.checks.forEach((check, i) => {
      const probability = answers[`c${i}`]?.noul;
      if (probability === undefined || !Number.isFinite(probability))
        unchecked.push(`验收点「${check}」没有得到有效判断`);
      else if (probability < deps.threshold) unmet.push(check);
    });
    return { unmet, ...(unchecked.length ? { unchecked } : {}) };
  }

  return {
    /**
     * 节点出口的关卡（一次运行），或任务的整体验收（几个负责交付物的节点的运行一起看，nodeId 为 null）。
     */
    async check(input: GateInput): Promise<GateResult> {
      const unmet = checkRules(
        input.runs.flatMap((r) => r.outputs),
        input.expects,
      );
      // 规则没过就不用再问 Jev 了（连产出都没有，验收点无从谈起）
      if (unmet.length > 0) return { unmet };
      const unchecked: string[] = [];
      if (input.nodeId)
        for (const run of input.runs) {
          if (run.outputs.some((file) => file.path.endsWith('/oasis-app.json'))) {
            try {
              const result = await harness.json(
                'POST',
                `/internal/runs/${run.runId}/application-check`,
                {
                  body: { payerId: input.payerId, taskId: input.taskId },
                  schema: ApplicationCheckResult,
                },
              );
              if (!result.passed)
                unmet.push(`浏览器实际运行检查失败：${result.reason ?? '原因未返回'}`);
            } catch (err) {
              logger.warn({ err, taskId: input.taskId, runId: run.runId }, '浏览器检查未完成');
              unchecked.push('浏览器实际运行检查未完成');
            }
          }
          for (const kind of [
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
          ]) {
            const media = run.outputs.filter((file) => kind.pattern.test(file.path));
            if (!media.length) continue;
            try {
              const result = await harness.json(
                'POST',
                `/internal/runs/${run.runId}/${kind.name}-check`,
                {
                  body: { payerId: input.payerId, taskId: input.taskId },
                  schema: kind.schema,
                },
              );
              for (const file of media) {
                const checked = result.files.find((item) => item.path === file.path);
                if (!checked) unchecked.push(`${kind.label}「${file.path}」未完成解码检查`);
                else if (!checked.valid)
                  unmet.push(
                    `${kind.label}「${file.path}」${checked.error ?? '探测或完整解码失败'}`,
                  );
                else if (kind.name === 'video') {
                  const video = VideoCheckResult.shape.files.element.parse(checked);
                  if (video.blackIntervals?.length)
                    unchecked.push(`视频「${file.path}」检出黑帧区间，需核对是否有意留黑`);
                  if (video.silentIntervals?.length)
                    unchecked.push(`视频「${file.path}」检出静音区间，需核对是否符合要求`);
                  if (video.avDeltaMs !== undefined && Math.abs(video.avDeltaMs) > 150)
                    unchecked.push(
                      `视频「${file.path}」音画长度差 ${video.avDeltaMs} 毫秒，需核对`,
                    );
                  unchecked.push(
                    `${kind.label}「${file.path}」画面/字幕语义、音画同步和实际 Shotcut 重导出仍需核对`,
                  );
                }
              }
            } catch (err) {
              logger.warn({ err, runId: run.runId }, `${kind.label}检查未完成`);
              unchecked.push(`${kind.label}解码检查未完成`);
            }
          }
        }

      if (
        unmet.length > 0 ||
        (input.checks.length === 0 && input.expects.every((e) => typeof e === 'string'))
      )
        return { unmet, ...(unchecked.length ? { unchecked } : {}) };
      try {
        const semantic = await checkPoints(input);
        return {
          unmet: semantic.unmet,
          ...(unchecked.length || semantic.unchecked?.length
            ? { unchecked: [...unchecked, ...(semantic.unchecked ?? [])] }
            : {}),
        };
      } catch (err) {
        logger.warn({ err, taskId: input.taskId, nodeId: input.nodeId }, '验收点检查出错，放行');
        return { unmet: [], unchecked: [...unchecked, '验收点检查服务异常，检查未完成'] };
      }
    },
  };
}

export type Gate = ReturnType<typeof createGate>;
