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

  // ---- 音视频解码：每次开一个不联网的检查容器（核数和时限由付费的调用方定） ----
  /** Docker 的 socket；不填时 Linux/macOS 用 /var/run/docker.sock，Windows 用 Docker Desktop 的命名管道 */
  DOCKER_SOCKET: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** 沙箱基础镜像：自带 ffmpeg、oasis-media（pnpm sandbox:build 构建） */
  MEDIA_CHECK_IMAGE: z.string().default('oasis/harness-sandbox-base:0.2.1-rc.5'),
  MEDIA_CHECK_MEMORY_MB: positiveInt.max(16384).default(2048),
  MEDIA_CHECK_PIDS_LIMIT: positiveInt.max(4096).default(256),
  MEDIA_CHECK_MAX_FILES: positiveInt.max(100).default(20),
  /** 单个音视频最长多久，超过算不合格 */
  MEDIA_CHECK_MAX_DURATION_MS: positiveInt.max(3600_000).default(20 * 60_000),
  /** 同时最多开几个检查容器，多出来的排队 */
  MEDIA_CHECK_CONCURRENCY: positiveInt.max(16).default(2),

  // ---- 网页的浏览器检查：每次开一个检查浏览器容器（核数由付费的调用方定，不设时限） ----
  /** 检查浏览器镜像（pnpm browser:build 构建） */
  BROWSER_IMAGE: z.string().default('oasis/inspector-browser:1.64.0'),
  BROWSER_MEMORY_MB: positiveInt.max(16384).default(2048),
  BROWSER_PIDS_LIMIT: positiveInt.max(4096).default(512),
  /** 容器里应用监听的回环端口 */
  BROWSER_APP_PORT: positiveInt.min(1024).max(65535).default(3180),
  /** 同时最多开几个检查浏览器，多出来的排队 */
  BROWSER_CONCURRENCY: positiveInt.max(16).default(3),
  /** 外站测试明确放行的 HTTPS 来源，逗号分隔；为空时关闭外站访问 */
  WEBSITE_TEST_ORIGINS: list,

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
