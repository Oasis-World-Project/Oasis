import { objectStoreEnv, postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

export const canvasEnv = {
  ...postgresAndEventBus.env,
  // ---- 对象存储（素材，5.5c 起还有成果） ----
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-canvas'),
  /** 单个上传文件的大小上限；现在整个文件读进内存再存，调大之前要改成流式（ADR 0007） */
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
};
