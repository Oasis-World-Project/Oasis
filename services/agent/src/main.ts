// agent：模型目录（8 类，MVP 先上 14 个对话模型）、每个用户的 AI 人设（后续阶段）、自带 Key（后续阶段）。
import { fileURLToPath } from 'node:url';
import { postgresAndEventBus, startService } from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { createModelRepo } from './repo/model-repo.ts';
import { createModelService } from './service/model-service.ts';

await startService({
  name: 'agent',
  ...postgresAndEventBus,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  routes: (app, { resources }) =>
    registerRoutes(app, createModelService(createModelRepo(resources.postgres.pool))),
});
