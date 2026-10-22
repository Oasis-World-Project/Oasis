import { postgresAndEventBus } from '@oasis/service-kit';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const harnessEnv = {
  ...postgresAndEventBus.env,
  /** 签发、作废运行临时 Key */
  MODEL_GATEWAY_URL: z.url(),

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
  /** 沙箱里的 dsh 调模型用的地址（入口代理，只放行 chat completions 和决策两条路径） */
  SANDBOX_MODEL_BASE_URL: z.url().default('http://sandbox-ingress:8080/v1'),
  SANDBOX_CPUS: z.coerce.number().positive().max(64).default(2),
  SANDBOX_MEMORY_MB: positiveInt.default(2048),
  SANDBOX_PIDS_LIMIT: positiveInt.default(512),

  // ---- 运行 ----
  /** 同时进行的运行数上限，超出的排队 */
  MAX_CONCURRENT_RUNS: positiveInt.default(4),
  /** 一次运行最长多久（到点视为失败并销毁容器） */
  RUN_TIMEOUT_MS: positiveInt.default(30 * 60_000),
  /** 产出文件打包后的大小上限 */
  OUTPUT_MAX_BYTES: positiveInt.default(200 * 1024 * 1024),

  // ---- 对象存储（产出与会话存档） ----
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().default('oasis-harness'),
};
