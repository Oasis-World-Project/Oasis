// inspector 的内部接口（ADR 0024）：判断成果的检查都在这里——文件解析、音视频解码、网页的浏览器检查、
// 外站测试、模型预览、用户素材解析。
// inspector 不调别的服务、不存东西：要检查的内容由调用方给对象存储的临时下载链接（所属服务签发），
// 或直接放在请求里。要开容器的检查，算力由调用方在 model-gateway 冻结、按报回的实际用量结算。
import { z } from 'zod';
import { BrowserTestResult, UiTestReport, WebsiteTestArgs } from './ui-test.ts';

/** 所属服务签发的对象存储临时下载链接（inspector 只认配置里放行的对象存储地址） */
export const SourceLink = z.object({ url: z.url() });

/** 文件解析结果（关卡判断文件能不能用、数量和尺寸） */
export const InspectedFile = z.object({
  path: z.string(),
  text: z.string(),
  valid: z.boolean().optional(),
  error: z.string().optional(),
  warning: z.string().optional(),
  /** 已核验的证据范围；范围外的语义需要其他独立证据。 */
  evidenceScope: z.enum(['geometry', 'decoded-audio', 'decoded-video']).optional(),
  errorKind: z.enum(['invalid', 'incomplete']).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
});
export type InspectedFile = z.infer<typeof InspectedFile>;

export const InspectedFiles = z.object({ files: z.array(InspectedFile), truncated: z.boolean() });
export type InspectedFiles = z.infer<typeof InspectedFiles>;

/**
 * 解析一次运行的产出包（harness 存的 outputs.tar）里的这些文件；不在包里的跳过，
 * 空清单不回退为全部文件。
 */
export const FilesCheckBody = z.object({
  source: SourceLink,
  paths: z.array(z.string().min(1).max(500)).max(1000),
  maxChars: z.number().int().min(1).max(50_000).default(8000),
});
export type FilesCheckBody = z.input<typeof FilesCheckBody>;

// ---- 音视频、平台工程（.mlt）、字幕的解码检查：不联网、限核的独立容器里完整解码一遍 ----

/** 要做解码检查的文件（其余文件走文件解析） */
export const MEDIA_FILE = /\.(wav|mp3|m4a|flac|ogg|aac|webm|mp4|mov|mkv|avi|mlt|srt)$/i;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Interval = z.object({ startMs: z.number(), endMs: z.number() });

/** 一个文件的解码结果；画面语义、Shotcut 实际重导出不由解码结果代替 */
export const MediaCheckFile = z.object({
  path: z.string(),
  valid: z.boolean(),
  size: z.number().int().nonnegative().optional(),
  sha256: Sha256.optional(),
  durationMs: z.number().int().positive().optional(),
  codec: z.string().optional(),
  sampleRate: z.number().positive().optional(),
  channels: z.number().int().positive().optional(),
  peakDb: z.number().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  audioCodec: z.string().optional(),
  audioDurationMs: z.number().int().nonnegative().optional(),
  avDeltaMs: z.number().int().optional(),
  blackIntervals: z.array(Interval).max(200).optional(),
  silentIntervals: z.array(Interval).max(200).optional(),
  samples: z
    .array(z.object({ atMs: z.number().nonnegative(), sha256: Sha256 }))
    .max(3)
    .optional(),
  projectSources: z.number().int().positive().optional(),
  subtitleCues: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type MediaCheckFile = z.infer<typeof MediaCheckFile>;

/** 受信脚本（inspector/media/media-check.mjs）的报告 */
export const MediaCheckReport = z.object({
  files: z.array(MediaCheckFile).max(100),
  unchecked: z.array(z.string()).max(1000),
});
export type MediaCheckReport = z.infer<typeof MediaCheckReport>;

/**
 * 解码一次运行产出包里的这些文件。核数和时限由付费的调用方定（它按这些冻结算力）；
 * 平台工程引用的素材会一起放进检查容器。
 */
export const MediaCheckBody = z.object({
  source: SourceLink,
  paths: z.array(z.string().min(1).max(500)).min(1).max(1000),
  cores: z.number().positive().max(8),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(10 * 60_000),
});
export type MediaCheckBody = z.infer<typeof MediaCheckBody>;

/** 检查容器实际用的算力：调用方据此结算（核数 × 脚本实际运行时长） */
export const ComputeUsage = z.object({
  cores: z.number().positive().max(64),
  elapsedMs: z.number().int().nonnegative(),
});
export type ComputeUsage = z.infer<typeof ComputeUsage>;

/** 请求里的文件：查过的在 files 里，没查到的（超出上限、超时、不在包里）在 unchecked 里 */
export const MediaCheckResult = MediaCheckReport.extend({ usage: ComputeUsage });
export type MediaCheckResult = z.infer<typeof MediaCheckResult>;

// ---- 网页的浏览器检查（ADR 0017、0021）：交付关卡、节点自查 app.check、外站测试共用一套检查浏览器 ----

/** 检查浏览器容器用几核（付费的调用方定） */
const BrowserCores = z.number().positive().max(8);
const RelativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.includes('\\') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    '路径要相对 out/，不能有 . 或 ..',
  );

/**
 * 浏览器检查的结论（交付关卡、节点自查）。页面本身的问题如实写在这里（passed=false 和原因）；
 * 检查程序自己出错时接口直接报错，调用方记为没检查到。
 */
export const ApplicationCheckResult = z.object({
  application: BrowserTestResult.shape.application,
  passed: z.boolean(),
  reason: z.string().nullable(),
  frameCaptured: z.boolean(),
  report: UiTestReport.optional(),
  inputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** 平台截取的画面（打开后的首屏 opening.jpg 与测试步骤截图），不是节点自述 */
  screenshots: z.array(z.object({ name: z.string().max(100), base64: z.string() })).optional(),
});
export type ApplicationCheckResult = z.infer<typeof ApplicationCheckResult>;

/** 交付关卡：检查运行产出包里这份清单（out/ 下的路径）所在的应用 */
export const ApplicationCheckBody = z.object({
  source: SourceLink,
  manifest: RelativePath.refine((path) => path.endsWith('/oasis-app.json'), '清单路径不对'),
  cores: BrowserCores,
});
export type ApplicationCheckBody = z.infer<typeof ApplicationCheckBody>;

/** 节点自查（app.check）：out/<dir> 里的文件随调用带来（沙箱上传，经 model-gateway 转来） */
export const ApplicationFilesCheckBody = z.object({
  dir: RelativePath,
  files: z
    .array(z.object({ path: RelativePath, contentBase64: z.string() }))
    .min(1)
    .max(1000),
  cores: BrowserCores,
  /** 把平台截的画面（打开后的首屏、测试步骤截图）也交回：节点要看画面时用 */
  screenshots: z.boolean().optional(),
});
export type ApplicationFilesCheckBody = z.infer<typeof ApplicationFilesCheckBody>;

export const ApplicationCheckReply = ApplicationCheckResult.extend({ usage: ComputeUsage });
export type ApplicationCheckReply = z.infer<typeof ApplicationCheckReply>;

/** 外站测试（website.test）：只按测试计划访问放行来源的 HTTPS 页面 */
export const WebsiteCheckBody = WebsiteTestArgs.extend({ cores: BrowserCores });
export type WebsiteCheckBody = z.infer<typeof WebsiteCheckBody>;
export const WebsiteCheckReply = BrowserTestResult.extend({ usage: ComputeUsage });
export type WebsiteCheckReply = z.infer<typeof WebsiteCheckReply>;

/** 解析用户上传的素材：canvas 核对过所有权、签发了下载链接；不接受任意 URL 或本机路径。 */
export const MaterialsInspectBody = z.object({
  files: z
    .array(
      z.object({
        uploadId: z.uuid(),
        name: z.string(),
        size: z.number().int().nonnegative(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable()
          .optional(),
        url: z.url(),
      }),
    )
    .max(20),
  maxChars: z.number().int().min(1).max(50_000).default(30_000),
});
export type MaterialsInspectBody = z.input<typeof MaterialsInspectBody>;

export const MaterialInspection = z.object({
  uploadId: z.uuid(),
  name: z.string(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  text: z.string(),
  status: z.enum(['complete', 'partial', 'unsupported', 'failed']),
  reason: z.string().optional(),
  /** 图片素材（如批注截图）没有正文，原图交给关卡的看图检查（2026-11-05） */
  image: z
    .object({
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      base64: z.string(),
    })
    .optional(),
});
export const MaterialInspectResult = z.object({ files: z.array(MaterialInspection).max(20) });
export type MaterialInspectResult = z.infer<typeof MaterialInspectResult>;
