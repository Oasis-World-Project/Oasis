// 配置全部来自环境变量（12-Factor），启动时一次性校验，缺什么一次列全。
import { z } from 'zod';

/** 每个服务都有的配置项。 */
const baseEnv = {
  PORT: z.coerce.number().int().min(0).max(65535),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** 收到退出信号后，先让 /ready 返回 503 并等待这么久，给负载均衡摘流量的时间。 */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(0),
  /** 优雅关闭的总时限，超时强制退出。 */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).default(10_000),
  /** 启动前执行本服务的数据库迁移（本地开发和 compose 打开；上 K8s 后改为单独的迁移任务） */
  MIGRATE_ON_START: z.stringbool().default(false),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_COMMIT: z.string().min(1).default('unknown'),
};

export type EnvShape = z.ZodRawShape;
type BaseConfig = z.infer<z.ZodObject<typeof baseEnv>>;
export type ConfigOf<E extends EnvShape> = BaseConfig & z.infer<z.ZodObject<E>>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig<E extends EnvShape>(
  extra: E,
  source: Record<string, string | undefined>,
): ConfigOf<E> {
  const result = z.object({ ...baseEnv, ...extra }).safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}：${issue.message}`,
    );
    throw new ConfigError(`环境变量配置有误，服务无法启动：\n${lines.join('\n')}`);
  }
  return result.data as ConfigOf<E>;
}
