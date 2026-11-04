// conversation：群聊与私聊（MVP 先做私聊）。消息存库，AI 回复经 model-gateway 流式返回；
// 私聊里认出任务就转去接需求，确认任务单后交给 task（ADR 0005）。
import { fileURLToPath } from 'node:url';
import { TASK_STREAM, TaskDeleted, TaskStatusChanged } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  startEventConsumer,
  startService,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { registerGroupRoutes } from './api/group-routes.ts';
import { createGroupRepo } from './repo/group-repo.ts';
import { createGroupService } from './service/group-service.ts';
import { conversationEnv } from './config.ts';
import { createConversationRepo } from './repo/conversation-repo.ts';
import { createDmService } from './service/dm-service.ts';
import { createIntakeService } from './service/intake-service.ts';
import { createRevisionService } from './service/revision-service.ts';
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
    // 任务被删除（用户删除或被新版替换）：它的卡片标成已替换 / 已删除（ADR 0012）
    const taskDeleted = startEventConsumer({
      connection: eventBus.connection,
      stream: TASK_STREAM,
      durable: 'conversation-task-deleted',
      filterSubject: TaskDeleted.type,
      logger: ctx.logger,
      handle: (envelope) => notices.onDeleted(TaskDeleted.data.parse(envelope.data)),
    });
    return { postgres, eventBus, taskStatus, taskDeleted };
  },
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  routes: (app, { config, resources, logger }) => {
    const repo = createConversationRepo(resources.postgres.pool);
    const agent = createServiceClient('agent', config.AGENT_URL, { timeoutMs: 3_000 });
    const modelGateway = createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
      timeoutMs: config.MODEL_GATEWAY_TIMEOUT_MS,
    });
    const intake = createIntakeService({
      repo,
      agent,
      modelGateway,
      task: createServiceClient('task', config.TASK_URL, { timeoutMs: 10_000 }),
      harness: createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 45_000 }),
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
    const canvas = createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 5_000 });
    const revisions = createRevisionService({
      repo,
      task: createServiceClient('task', config.TASK_URL, { timeoutMs: 10_000 }),
      logger,
    });
    const dms = createDmService({
      repo,
      agent,
      modelGateway,
      canvas,
      intake,
      historyLimit: config.HISTORY_LIMIT,
      replyMaxTokens: config.REPLY_MAX_TOKENS,
      detect: { high: config.TASK_DETECT_HIGH, low: config.TASK_DETECT_LOW },
      logger,
    });
    registerRoutes(app, dms, intake, revisions);
    registerGroupRoutes(
      app,
      createGroupService(
        createGroupRepo(resources.postgres.pool, {
          members: config.GROUP_MAX_MEMBERS,
          groups: config.GROUP_MAX_PER_USER,
          messagesPerMinute: config.GROUP_MESSAGES_PER_MINUTE,
        }),
      ),
      config.GROUP_STREAMS_PER_USER,
    );
  },
});
