// agent：模型目录（8 类，MVP 先上 14 个对话模型）、用户给 AI 们的设置；每个 AI 的人设以后再加。
import { fileURLToPath } from 'node:url';
import { createPostgres, databaseEnv, startService } from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { createModelRepo } from './repo/model-repo.ts';
import { createModelService } from './service/model-service.ts';

await startService({
  name: 'agent',
  env: databaseEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async ({ config, logger }) => ({
    postgres: createPostgres(config.DATABASE_URL, logger),
  }),
  routes: (app, { resources }) =>
    registerRoutes(app, createModelService(createModelRepo(resources.postgres.pool))),
});
