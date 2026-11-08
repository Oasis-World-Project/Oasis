// 做几版挑一版（ADR 0026）：各版都做完后开一次挑选运行，结果写在 out/pick.txt：{"choice":版本号,"reason":"…"}。
// - 图片：各缩成宽 1024 的 JPEG，视觉模型一起看（image.inspect）；视频：先各抽第 1 秒的一帧再看。
// - 其他产出（文字、网页、代码……）：开一个单轮的 AI 运行读完各版再比较（需要时它自己用 jev.decide）。
// 理由要说出具体差别；挑选失败、结果不可用都先用做成的第一版，原因写进提醒。
import { TOOL_RUN_MODEL } from '@oasis/contracts/harness';
import type { ToolStep } from '@oasis/contracts/tool-step';
import type { Node } from '../repo/task-store.ts';
import type { RunRequest } from './kinds/index.ts';

/** 挑选结果写在这里（运行产出里叫 pick.txt） */
export const PICK_FILE = 'pick.txt';
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const VIDEO = /\.(?:mp4|mov|webm|mkv)$/i;
/** 理由至少这么长才算说出了具体差别 */
const MIN_REASON = 15;
/** 看图挑选前把各版图片缩到多宽（像素） */
const PREVIEW_WIDTH = 1024;

/** 版本号：版本子节点记在 config.version 上 */
export const versionOf = (child: Node) => child.config.version?.k ?? child.slot ?? 0;

const firstOf = (child: Node, pattern: RegExp) =>
  child.outputs
    .map((f) => f.path)
    .filter((p) => pattern.test(p))
    .sort()[0];

const answer =
  '只回答一个 JSON：{"choice": 版本号, "reason": "具体说出选中的这一版和其他版的差别，为什么它更符合标准"}';

/** 挑选运行：done 是做成了的各版（至少两版） */
export function pickRequest(group: Node, done: Node[], aiModel: string): RunRequest {
  const standard = group.config.variants?.pick ?? '整体质量最好';
  const labels = done.map((c) => `第 ${versionOf(c)} 版`).join('、');
  const inputsFrom = done.map((c) => ({
    runId: c.config.outputsRunId!,
    as: `v${versionOf(c)}`,
  }));
  const base = {
    purpose: 'pick' as const,
    inputsFrom,
    inputs: [],
    meta: {},
  };
  const images = done.map((c) => firstOf(c, IMAGE));
  const videos = done.map((c) => firstOf(c, VIDEO));
  let steps: ToolStep[] | undefined;
  if (images.every(Boolean)) {
    // 先各缩成宽 PREVIEW_WIDTH 的 JPEG 再看：原图可能很大（2K 的 PNG 约 10 MB），两版就超过看图工具
    // 20 MiB 的上限（2026-11-08 真实小样：挑选失败、先用了第 1 版）。挑版看构图和内容，不需要原图
    steps = [
      ...done.map((c, i) => ({
        tool: 'op.media.convert',
        args: { in: `in/v${versionOf(c)}/${images[i]}`, width: String(PREVIEW_WIDTH) },
        out: `out/preview-v${versionOf(c)}.jpg`,
      })),
      {
        tool: 'image.inspect',
        args: {
          images: done.map((c) => `out/preview-v${versionOf(c)}.jpg`),
          question: `这几张图依次是${labels}，是同一步做的几个版本。挑选标准：${standard}。${answer}`,
        },
        out: `out/${PICK_FILE}`,
      },
    ];
  } else if (videos.every(Boolean)) {
    steps = [
      ...done.map((c, i) => ({
        tool: 'op.video.frames',
        args: { in: `in/v${versionOf(c)}/${videos[i]}`, at: '1', format: 'jpg' },
        out: `out/frames-v${versionOf(c)}`,
      })),
      {
        tool: 'image.inspect',
        args: {
          images: done.map((c) => `out/frames-v${versionOf(c)}/frame-0001.jpg`),
          question: `这几张图依次是${labels}视频第 1 秒的画面，是同一步做的几个版本。挑选标准：${standard}。${answer}`,
        },
        out: `out/${PICK_FILE}`,
      },
    ];
  }
  if (steps) return { ...base, model: TOOL_RUN_MODEL, prompt: `挑一版：${group.title}`, steps };
  return {
    ...base,
    model: aiModel,
    prompt: [
      `「${group.title}」同时做了几版，各版的成果在 ${done.map((c) => `in/v${versionOf(c)}/`).join('、')}（${labels}）。`,
      `按这个标准挑一版：${standard}。`,
      '先把各版都看完再判断，需要时可以用 `oasis-tool jev.decide` 帮忙比较。不要修改任何一版。',
      `把结果写成 out/${PICK_FILE}，${answer}`,
    ].join('\n'),
  };
}

/** 读挑选结果：版本号要是做成了的一版，理由要说出具体差别 */
export function parsePick(
  text: string | undefined,
  allowed: number[],
): { choice: number; reason: string } | { problem: string } {
  if (text === undefined) return { problem: `没有写出 ${PICK_FILE}` };
  const match = /\{[\s\S]*\}/.exec(text);
  let data: { choice?: unknown; reason?: unknown } | undefined;
  try {
    data = match ? (JSON.parse(match[0]) as typeof data) : undefined;
  } catch {
    data = undefined;
  }
  if (!data) return { problem: '挑选结果不是 JSON' };
  const choice = Number(data.choice);
  if (!allowed.includes(choice))
    return { problem: `选了第 ${String(data.choice)} 版，不在做成的几版里` };
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (reason.length < MIN_REASON) return { problem: '理由太笼统，没说出各版的具体差别' };
  return { choice, reason: reason.slice(0, 500) };
}
