// agent：「AI 们」（能聊天的 AI 们和各工具用的型号，都在型号清单 @oasis/contracts/lineup 里）、用户给
// AI 们的设置（只用国内模型、每个 AI 用哪一档、给它定的名字和人格）。
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
