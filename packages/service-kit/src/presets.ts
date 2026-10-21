// 大多数业务服务的标准依赖组合：自己的 PostgreSQL 库 + NATS 事件总线。
import { connectEventBus, eventBusEnv, type EventBusResource } from './event-bus.ts';
import { createPostgres, databaseEnv, type PostgresResource } from './postgres.ts';
import type { ServiceContext } from './service.ts';

const env = { ...databaseEnv, ...eventBusEnv };

export interface StandardResources {
  [name: string]: PostgresResource | EventBusResource;
  postgres: PostgresResource;
  eventBus: EventBusResource;
}

export async function connectPostgresAndEventBus({
  config,
  logger,
  name,
}: ServiceContext<typeof env>): Promise<StandardResources> {
  return {
    postgres: createPostgres(config.DATABASE_URL, logger),
    eventBus: await connectEventBus(config, name, logger),
  };
}

export const postgresAndEventBus = { env, resources: connectPostgresAndEventBus };
