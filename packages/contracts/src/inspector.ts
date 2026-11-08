// inspector 的内部接口（ADR 0024）：判断成果的检查都在这里——文件解析、模型预览、用户素材解析。
// inspector 不调别的服务、不存东西：要检查的内容由调用方给对象存储的临时下载链接（所属服务签发），
// 或直接放在请求里。
import { z } from 'zod';

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
