import { objectStoreEnv, postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const harnessEnv = {
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
  /** 沙箱镜像（dsh 版本锁定在镜像标签里） */
  SANDBOX_IMAGE: z.string().default('oasis/harness-sandbox-base:0.2.1-rc.2'),
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

  // ---- 运行 ----
  /** 同时进行的运行数上限，超出的排队 */
  MAX_CONCURRENT_RUNS: positiveInt.default(4),
  /** 一次运行最长多久（到点视为失败并销毁容器） */
  RUN_TIMEOUT_MS: positiveInt.default(30 * 60_000),
  /** 一次运行的素材（用户上传的文件）加起来的大小上限 */
  MATERIALS_MAX_BYTES: positiveInt.default(300 * 1024 * 1024),
  /** 产出文件打包后的大小上限 */
  OUTPUT_MAX_BYTES: positiveInt.default(200 * 1024 * 1024),

  // ---- 对象存储（产出与会话存档） ----
  ...objectStoreEnv,
  S3_BUCKET: z.string().default('oasis-harness'),
};
