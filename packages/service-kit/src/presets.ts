// 大多数业务服务的标准依赖组合：自己的 PostgreSQL 库 + NATS 事件总线。
import { connectEventBus, eventBusEnv } from './event-bus.ts';
import { createPostgres, databaseEnv } from './postgres.ts';
import type { ServiceDefinition } from './service.ts';

const env = { ...databaseEnv, ...eventBusEnv };

export const postgresAndEventBus = {
  env,
  resources: async ({ config, logger, name }) => [
    createPostgres(config.DATABASE_URL, logger),
    await connectEventBus(config, name, logger),
  ],
} satisfies Required<Pick<ServiceDefinition<typeof env>, 'env' | 'resources'>>;
