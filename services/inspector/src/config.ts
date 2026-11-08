import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const list = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

export const inspectorEnv = {
  /**
   * 下载链接只认这些来源（对象存储的地址，逗号分隔）：inspector 只读所属服务签发的临时链接，
   * 不能被当成任意网址的代理。
   */
  SOURCE_ORIGINS: list.pipe(z.array(z.url()).min(1)),
  /** 下载一个检查对象（运行产出包、素材）最多等多久 */
  SOURCE_TIMEOUT_MS: positiveInt.max(600_000).default(120_000),
  /** 运行产出包的大小上限（和 harness 存产出的上限一致） */
  SOURCE_MAX_BYTES: positiveInt.default(2 * 1024 * 1024 * 1024),

  // ---- 文件解析（在独立 worker 里做，逐文件有资源上限） ----
  EXTRACT_INPUT_BYTES: positiveInt.max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  EXTRACT_UNZIP_BYTES: positiveInt.max(200 * 1024 * 1024).default(50 * 1024 * 1024),
  EXTRACT_MAX_ENTRIES: positiveInt.max(10000).default(2000),
  EXTRACT_MAX_PAGES: positiveInt.max(1000).default(200),
  EXTRACT_MAX_CELLS: positiveInt.max(100000).default(20000),
  EXTRACT_MAX_PIXELS: positiveInt.max(100000000).default(25000000),
  EXTRACT_TIMEOUT_MS: positiveInt.max(60000).default(10000),
  EXTRACT_TOTAL_MS: positiveInt.max(120000).default(30000),
  EXTRACT_MAX_FILES: positiveInt.max(1000).default(1000),
};
