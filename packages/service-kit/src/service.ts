// 服务的生命周期：读配置 → 建日志 → （可选）迁移数据库 → 连依赖 → 注册路由 → 监听；
// 收到 SIGTERM/SIGINT 时优雅关闭。
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, loadConfig, type ConfigOf, type EnvShape } from './config.ts';
import { createHttpServer, type ServiceApp } from './http.ts';
import { createLogger, type Logger } from './logger.ts';
import { runMigrations } from './migrate.ts';
import type { ServiceResource } from './resource.ts';

/** 服务持有的外部依赖，按名字取用（如 resources.postgres.pool）。 */
export type ResourceMap = Record<string, ServiceResource>;

export interface ServiceContext<E extends EnvShape> {
  readonly name: string;
  readonly config: ConfigOf<E>;
  readonly logger: Logger;
}

export interface ServiceDefinition<E extends EnvShape, R extends ResourceMap = ResourceMap> {
  /** 服务名，同时用作日志字段、NATS 客户端名和事件来源。 */
  name: string;
  /** 本服务在通用配置之外需要的环境变量。 */
  env: E;
  /** 本服务的 dbmate 迁移目录。MIGRATE_ON_START=true 时在连依赖之前执行（需要 DATABASE_URL）。 */
  migrationsDir?: string;
  /** 创建本服务持有的外部依赖；/ready 会逐项检查，关闭时倒序释放。 */
  resources?: (ctx: ServiceContext<E>) => Promise<R>;
  /** 注册本服务的业务路由。 */
  routes?: (app: ServiceApp, ctx: ServiceContext<E> & { resources: R }) => void | Promise<void>;
}

export interface Service<
  E extends EnvShape,
  R extends ResourceMap = ResourceMap,
> extends ServiceContext<E> {
  readonly app: ServiceApp;
  readonly resources: R;
  listen(): Promise<string>;
  /** 优雅关闭：/ready 先变 503，等在途请求结束，再倒序关闭依赖。可重复调用。 */
  stop(): Promise<void>;
}

async function migrateIfEnabled<E extends EnvShape>(
  definition: ServiceDefinition<E, ResourceMap>,
  config: ConfigOf<E>,
  logger: Logger,
): Promise<void> {
  if (!definition.migrationsDir || !config.MIGRATE_ON_START) return;
  const databaseUrl = (config as Record<string, unknown>).DATABASE_URL;
  if (typeof databaseUrl !== 'string') {
    throw new ConfigError('MIGRATE_ON_START=true 但本服务没有 DATABASE_URL');
  }
  await runMigrations({ databaseUrl, migrationsDir: definition.migrationsDir, logger });
}

export async function createService<E extends EnvShape, R extends ResourceMap = ResourceMap>(
  definition: ServiceDefinition<E, R>,
  source: Record<string, string | undefined> = process.env,
): Promise<Service<E, R>> {
  const config = loadConfig(definition.env, source);
  const logger = createLogger(definition.name, config.LOG_LEVEL);
  const ctx: ServiceContext<E> = { name: definition.name, config, logger };

  await migrateIfEnabled(definition as ServiceDefinition<E, ResourceMap>, config, logger);
  const resources = ((await definition.resources?.(ctx)) ?? {}) as R;
  const resourceList = Object.values(resources);

  let shuttingDown = false;
  const app = createHttpServer({
    service: definition.name,
    version: config.SERVICE_VERSION,
    commit: config.GIT_COMMIT,
    logger,
    resources: resourceList,
    isShuttingDown: () => shuttingDown,
  });
  await definition.routes?.(app, { ...ctx, resources });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      shuttingDown = true;
      logger.info('开始优雅关闭');
      if (config.SHUTDOWN_DRAIN_MS > 0) await delay(config.SHUTDOWN_DRAIN_MS);
      await app.close();
      for (const resource of [...resourceList].reverse()) {
        try {
          await resource.close();
        } catch (err) {
          logger.error({ err, resource: resource.name }, '关闭依赖失败');
        }
      }
      logger.info('已关闭');
    })());

  return {
    ...ctx,
    app,
    resources,
    stop,
    listen: () => app.listen({ port: config.PORT, host: config.HOST }),
  };
}

function exitWithFatal(name: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const line = { level: 'fatal', time: new Date().toISOString(), service: name, msg };
  process.stderr.write(`${JSON.stringify(line)}\n`);
  process.exit(1);
}

/** 服务入口用：创建并启动服务，挂好退出信号。启动失败时打一条 fatal 日志并以 1 退出。 */
export async function startService<E extends EnvShape, R extends ResourceMap = ResourceMap>(
  definition: ServiceDefinition<E, R>,
): Promise<void> {
  let service: Service<E, R>;
  try {
    service = await createService(definition);
  } catch (err) {
    exitWithFatal(definition.name, err);
  }

  const onSignal = (signal: NodeJS.Signals) => {
    service.logger.info({ signal }, '收到退出信号');
    setTimeout(() => {
      service.logger.error('优雅关闭超时，强制退出');
      process.exit(1);
    }, service.config.SHUTDOWN_GRACE_MS).unref();
    service.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        service.logger.error({ err }, '优雅关闭失败');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    await service.listen();
  } catch (err) {
    exitWithFatal(definition.name, err);
  }
}
