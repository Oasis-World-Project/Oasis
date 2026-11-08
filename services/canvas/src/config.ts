import { objectStoreEnv, postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const canvasEnv = {
  ...postgresAndEventBus.env,
  /** 任务完成时取任务详情和成果文件（ADR 0007 §8） */
  TASK_URL: z.url(),
  INSPECTOR_URL: z.url(),
  /** 数字人会话（ADR 0013）由 model-gateway 开；没配时成果页不能开实时对话 */
  MODEL_GATEWAY_URL: z
    .union([z.literal(''), z.url()])
    .optional()
    .transform((value) => value || undefined),
  // ---- 对象存储（素材，5.5c 起还有成果） ----
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-canvas'),
  PREVIEW_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  PREVIEW_UNZIP_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  PREVIEW_MAX_ENTRIES: z.coerce.number().int().positive().default(2000),
  PREVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PREVIEW_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ARCHIVE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  ARCHIVE_MAX_FILES: z.coerce.number().int().positive().default(1000),
  /** 上传与成果按流处理；单文件和并发仍有硬上限。 */
  UPLOAD_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  FILE_TRANSFER_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024 * 1024),
};
