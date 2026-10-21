// conversation：群聊与私聊（MVP 先做私聊）。消息存库，AI 回复经 model-gateway 流式返回。
import { fileURLToPath } from 'node:url';
import { createServiceClient, postgresAndEventBus, startService } from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { conversationEnv } from './config.ts';
import { createConversationRepo } from './repo/conversation-repo.ts';
import { createDmService } from './service/dm-service.ts';

await startService({
  name: 'conversation',
  env: conversationEnv,
  resources: postgresAndEventBus.resources,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  routes: (app, { config, resources, logger }) =>
    registerRoutes(
      app,
      createDmService({
        repo: createConversationRepo(resources.postgres.pool),
        agent: createServiceClient('agent', config.AGENT_URL, { timeoutMs: 3_000 }),
        modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL),
        historyLimit: config.HISTORY_LIMIT,
        replyMaxTokens: config.REPLY_MAX_TOKENS,
        logger,
      }),
    ),
});
