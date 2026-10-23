// conversation：群聊与私聊（MVP 先做私聊）。消息存库，AI 回复经 model-gateway 流式返回；
// 私聊里认出任务就转去接需求，确认任务单后交给 task（ADR 0005）。
import { fileURLToPath } from 'node:url';
import { TASK_STREAM, TaskStatusChanged } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  startEventConsumer,
  startService,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { conversationEnv } from './config.ts';
import { createConversationRepo } from './repo/conversation-repo.ts';
import { createDmService } from './service/dm-service.ts';
import { createIntakeService } from './service/intake-service.ts';
import { createTaskNotices } from './service/task-notices.ts';

await startService({
  name: 'conversation',
  env: conversationEnv,
  resources: async (ctx) => {
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    // 任务的结果回到私聊：交付消息、需要处理的提醒
    const notices = createTaskNotices({
      repo: createConversationRepo(postgres.pool),
      task: createServiceClient('task', ctx.config.TASK_URL, { timeoutMs: 10_000 }),
      logger: ctx.logger,
    });
    const taskStatus = startEventConsumer({
      connection: eventBus.connection,
      stream: TASK_STREAM,
      durable: 'conversation-task-status',
      filterSubject: TaskStatusChanged.type,
      logger: ctx.logger,
      handle: (envelope) =>
        notices.onStatusChanged(envelope.id, TaskStatusChanged.data.parse(envelope.data)),
    });
    return { postgres, eventBus, taskStatus };
  },
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  routes: (app, { config, resources, logger }) => {
    const repo = createConversationRepo(resources.postgres.pool);
    const agent = createServiceClient('agent', config.AGENT_URL, { timeoutMs: 3_000 });
    const modelGateway = createServiceClient('model-gateway', config.MODEL_GATEWAY_URL);
    const intake = createIntakeService({
      repo,
      agent,
      modelGateway,
      task: createServiceClient('task', config.TASK_URL, { timeoutMs: 10_000 }),
      config: {
        detectModel: config.TASK_DETECT_MODEL,
        detectHigh: config.TASK_DETECT_HIGH,
        detectLow: config.TASK_DETECT_LOW,
        fallbackModel: config.INTAKE_FALLBACK_MODEL,
        maxRounds: config.INTAKE_MAX_ROUNDS,
        maxTokens: config.INTAKE_MAX_TOKENS,
      },
      logger,
    });
    const dms = createDmService({
      repo,
      agent,
      modelGateway,
      canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 5_000 }),
      intake,
      historyLimit: config.HISTORY_LIMIT,
      replyMaxTokens: config.REPLY_MAX_TOKENS,
      detect: { high: config.TASK_DETECT_HIGH, low: config.TASK_DETECT_LOW },
      logger,
    });
    registerRoutes(app, dms, intake);
  },
});
