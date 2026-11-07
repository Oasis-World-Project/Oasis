import { objectStoreEnv, postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const harnessEnv = {
  WEBSITE_TEST_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ...postgresAndEventBus.env,
  /** 签发、作废运行临时 Key */
  MODEL_GATEWAY_URL: z.url(),
  /** 取用户上传的素材放进沙箱 */
  CANVAS_URL: z.url(),

  // ---- 执行器（Docker Engine API） ----
  /** Docker 的 socket；不填时 Linux/macOS 用 /var/run/docker.sock，Windows 用 Docker Desktop 的命名管道 */
  DOCKER_SOCKET: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** 沙箱镜像（dsh 版本锁定在镜像标签里）。默认带 Blender 的 3D 版：它是基础版的超集，
   *  节点按需求自行决定是否建模（ADR 0011 §21；按节点选镜像尚未实现）。 */
  SANDBOX_IMAGE: z.string().default('oasis/harness-sandbox-3d:0.2.1-rc.5-blender4.3.2'),
  PREVIEW_IMAGE: z.string().default('oasis/harness-preview:1.64.0'),
  PREVIEW_CPUS: z.coerce.number().positive().max(8).default(2),
  PREVIEW_MEMORY_MB: positiveInt.default(2048),
  PREVIEW_PIDS_LIMIT: positiveInt.default(512),
  PREVIEW_APP_PORT: positiveInt.max(65535).default(3180),
  PREVIEW_MAX_MS: positiveInt.max(60 * 60_000).default(30 * 60_000),
  /** 沙箱所在的内部网络：不通外网，只能访问沙箱入口代理 */
  SANDBOX_NETWORK: z.string().default('oasis-sandbox'),
  /** 沙箱里的 dsh 调模型、oasis-tool 调工具用的地址（入口代理，只放行几条 /run/v1/* 路径） */
  SANDBOX_MODEL_BASE_URL: z.url().default('http://sandbox-ingress:8080/v1'),
  /** 沙箱装软件包时走的出口代理（只放行软件包仓库）；留空就不给沙箱任何出站通路 */
  SANDBOX_EGRESS_PROXY: z
    .string()
    .default('http://sandbox-egress:8888')
    .transform((value) => value || undefined)
    .pipe(z.url().optional()),
  /** 沙箱里 npm、pip 用的仓库；默认官方源，开发机在根目录 .env 里换成国内镜像站 */
  SANDBOX_NPM_REGISTRY: z.url().default('https://registry.npmjs.org/'),
  SANDBOX_PIP_INDEX_URL: z.url().default('https://pypi.org/simple'),
  SANDBOX_CPUS: z.coerce.number().positive().max(64).default(2),
  SANDBOX_MEMORY_MB: positiveInt.default(2048),
  SANDBOX_PIDS_LIMIT: positiveInt.default(512),
  OASIS_BATCH_CONCURRENCY: positiveInt.max(16).default(4),
  OASIS_BATCH_MAX_INPUT_BYTES: positiveInt.max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  EXTRACT_INPUT_BYTES: positiveInt.max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  EXTRACT_UNZIP_BYTES: positiveInt.max(200 * 1024 * 1024).default(50 * 1024 * 1024),
  EXTRACT_MAX_ENTRIES: positiveInt.max(10000).default(2000),
  EXTRACT_MAX_PAGES: positiveInt.max(1000).default(200),
  EXTRACT_MAX_CELLS: positiveInt.max(100000).default(20000),
  EXTRACT_MAX_PIXELS: positiveInt.max(100000000).default(25000000),
  EXTRACT_TIMEOUT_MS: positiveInt.max(60000).default(10000),
  EXTRACT_TOTAL_MS: positiveInt.max(120000).default(30000),
  EXTRACT_MAX_FILES: positiveInt.max(1000).default(1000),

  // ---- 运行 ----
  /** 同时进行的运行数上限，超出的排队 */
  MAX_CONCURRENT_RUNS: positiveInt.default(4),
  RECOVERY_INTERVAL_MS: positiveInt.default(15000),
  MEDIA_CHECK_MAX_FILES: positiveInt.max(100).default(20),
  MEDIA_CHECK_TIMEOUT_MS: positiveInt.max(300_000).default(90_000),
  MEDIA_CHECK_MAX_DURATION_MS: positiveInt.max(3600_000).default(20 * 60_000),
  FILE_TRANSFER_TIMEOUT_MS: positiveInt.default(600_000),
  /** 计费窗口会续租，不限制任务总时长。 */
  GOAL_ROUND_WINDOW: positiveInt.min(2).default(256),
  RUN_LEASE_MS: positiveInt
    .min(1000)
    .max(3600_000)
    .default(5 * 60_000),
  RUN_KEY_TTL_SECONDS: positiveInt
    .min(60)
    .max(7 * 24 * 3600)
    .default(6 * 3600),
  /** 一次运行的素材（用户上传的文件）加起来的大小上限 */
  MATERIALS_MAX_BYTES: positiveInt.optional(),
  /** 产出文件打包后的大小上限 */
  OUTPUT_MAX_BYTES: positiveInt.optional(),

  // ---- 对象存储（产出与会话存档） ----
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-harness'),
};
