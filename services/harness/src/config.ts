import { databaseEnv, objectStoreEnv } from '@oasis/service-kit';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const harnessEnv = {
  ...databaseEnv,
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
  /**
   * 云端的沙箱开在哪：docker 是这台机器上的 Docker（开发机、回归）；e2b 是租的 E2B 沙箱（线上）——
   * 一份会话一个，空着就暂停，同时能开多少个看 E2B 的档位（MAX_CONCURRENT_RUNS 照着填）。
   * 用 e2b 时沙箱里的 dsh 从公网调模型和工具（E2B_RUN_API_URL），装软件包直接访问放行的仓库（E2B_ALLOW_OUT），
   * 不经 SANDBOX_MODEL_BASE_URL、SANDBOX_EGRESS_PROXY 那两个代理。
   */
  CLOUD_EXECUTOR: z.enum(['docker', 'e2b']).default('docker'),
  E2B_API_KEY: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  /** E2B 上的模板名：按沙箱镜像的配方建的（pnpm sandbox:e2b） */
  E2B_TEMPLATE: z.string().default('oasis-harness-sandbox'),
  /** E2B 沙箱连续运行多久到点自动暂停（档位上限：Hobby 3600 秒） */
  E2B_TIMEOUT_SECONDS: positiveInt.max(86_400).default(3600),
  /** 公网上 gateway 的 /api/run/v1，如 https://oasis.example.com/api/run/v1（和用户电脑上的 dsh 走的是同一条路） */
  E2B_RUN_API_URL: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.url().optional()),
  /** E2B 沙箱除了 E2B_RUN_API_URL 那台主机，还能访问的域名（逗号分隔）；别的出站一律不通 */
  E2B_ALLOW_OUT: z.string().default('registry.npmjs.org,pypi.org,files.pythonhosted.org'),
  /** 沙箱镜像（dsh 版本锁定在镜像标签里）。默认带 Blender 的 3D 版：它是基础版的超集，
   *  AI 按需要自己决定要不要建模。 */
  SANDBOX_IMAGE: z.string().default('oasis/harness-sandbox-3d:0.2.1-rc.5-blender4.3.2'),
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
  /** 每个用户一块的缓存卷（下载下来的包、用时再装的工具链）最多占多少；超了开沙箱时从最久没用的删起 */
  SANDBOX_CACHE_MAX_MB: positiveInt.default(5120),
  /**
   * 一轮做完后，沙箱和里面的 dsh 空着留多少秒等同一份会话的下一轮（接着用就不用再起沙箱、起 dsh、读会话）；
   * 0 是做完就销毁。用户电脑上的另算：那边不占平台的机器
   */
  SANDBOX_IDLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  DEVICE_IDLE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(1800),
  /** 项目里的 oasis-setup.sh（新起的沙箱开工前执行）最多跑多少秒 */
  SANDBOX_SETUP_SECONDS: positiveInt.max(3600).default(300),
  OASIS_BATCH_CONCURRENCY: positiveInt.max(16).default(4),
  OASIS_BATCH_MAX_INPUT_BYTES: positiveInt.max(20 * 1024 * 1024).default(5 * 1024 * 1024),

  // ---- 运行 ----
  /** 同时进行的运行数上限，超出的排队 */
  MAX_CONCURRENT_RUNS: positiveInt.default(4),
  RECOVERY_INTERVAL_MS: positiveInt.default(15000),
  FILE_TRANSFER_TIMEOUT_MS: positiveInt.default(600_000),
  /** 计费窗口会续租，不限制一轮的总时长。 */
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
