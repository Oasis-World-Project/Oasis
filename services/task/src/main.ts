// task：工作流控制面（ADR 0004）。管任务的节点图、状态和调度；节点在 harness 里执行，
// 收到 harness.run.finished 就推进（讨论下一轮、过关卡），收到 model-gateway.call.settled 就累加花费，
// 并定时和 harness 对账。
import { fileURLToPath } from 'node:url';
import {
  CallSettled,
  HARNESS_STREAM,
  MODEL_GATEWAY_STREAM,
  RunFinished,
  TASK_STREAM,
} from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  ensureStream,
  startEventConsumer,
  startOutboxRelay,
  startService,
  type ServiceResource,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { createQuotes, type Quotes } from './service/quote.ts';
import { createRevisions, type Revisions } from './service/revision.ts';
import { taskEnv } from './config.ts';
import { createTaskStore } from './repo/task-store.ts';
import { createCheckCompute } from './service/check-compute.ts';
import { createGate } from './service/gate.ts';
import { createWorkflowService, type WorkflowService } from './service/workflow-service.ts';

let workflows: WorkflowService;
let quotes: Quotes;
let revisions: Revisions;

await startService({
  name: 'task',
  env: taskEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config, logger } = ctx;
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    await ensureStream(eventBus.connection, TASK_STREAM);
    // 任务状态变了就发 task.task.status_changed（conversation 更新任务卡、发交付消息）
    const outbox = startOutboxRelay({
      pool: postgres.pool,
      connection: eventBus.connection,
      logger,
    });
    const harness = createServiceClient('harness', config.HARNESS_URL, {
      timeoutMs: config.HARNESS_CHECK_TIMEOUT_MS,
    });
    const modelGateway = createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
      timeoutMs: 60_000,
    });
    const fallback = {
      workRun: config.ESTIMATE_WORK_RUN_MICRO,
      speechRun: config.ESTIMATE_SPEECH_RUN_MICRO,
      computeRun: config.ESTIMATE_COMPUTE_RUN_MICRO,
      nodeSeconds: config.ESTIMATE_NODE_SECONDS,
    };
    workflows = createWorkflowService({
      store: createTaskStore(postgres.pool),
      harness,
      gate: createGate({
        harness,
        inspector: createServiceClient('inspector', config.INSPECTOR_URL, {
          timeoutMs: config.HARNESS_CHECK_TIMEOUT_MS,
        }),
        compute: createCheckCompute({ modelGateway, logger }),
        media: { cores: config.MEDIA_CHECK_CPUS, timeoutMs: config.MEDIA_CHECK_TIMEOUT_MS },
        browser: { cores: config.BROWSER_CHECK_CPUS, maxMs: config.BROWSER_CHECK_MAX_MS },
        logger,
      }),
      maxParallel: config.MAX_PARALLEL_NODES,
      agent: createServiceClient('agent', config.AGENT_URL, { timeoutMs: 5_000 }),
      modelGateway,
      planning: {
        planner: config.PLANNER_MODEL,
        defaultModel: config.DEFAULT_NODE_MODEL,
        fallback,
      },
      logger,
    });
    quotes = createQuotes({
      modelGateway,
      pricing: () => workflows.pricing(),
      model: config.QUOTE_MODEL,
      planner: config.PLANNER_MODEL,
      fallback,
      logger,
    });
    revisions = createRevisions({
      workflows,
      canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 10_000 }),
    });
    const runFinished = startEventConsumer({
      connection: eventBus.connection,
      stream: HARNESS_STREAM,
      durable: 'task-run-finished',
      filterSubject: RunFinished.type,
      logger,
      handle: async (envelope) => {
        const data = RunFinished.data.parse(envelope.data);
        if (data.taskId) await workflows.onRunFinished(data);
      },
    });
    // 属于任务的模型调用结算了：累加花费（预算只是参考，不暂停，ADR 0016 §2）
    const callSettled = startEventConsumer({
      connection: eventBus.connection,
      stream: MODEL_GATEWAY_STREAM,
      durable: 'task-call-settled',
      filterSubject: CallSettled.type,
      logger,
      handle: async (envelope) => workflows.onCallSettled(CallSettled.data.parse(envelope.data)),
    });
    // 启动时对一次账，之后定时对账
    void workflows.reconcile(0).catch((err: unknown) => logger.warn({ err }, '启动对账失败'));
    const timer = setInterval(() => {
      void workflows.reconcile().catch((err: unknown) => logger.warn({ err }, '对账失败'));
    }, config.RECONCILE_INTERVAL_MS);
    const reconciler: ServiceResource = {
      name: 'reconciler',
      ready: async () => {},
      close: async () => clearInterval(timer),
    };
    return { postgres, eventBus, outbox, runFinished, callSettled, reconciler };
  },
  routes: (app) => registerRoutes(app, workflows, quotes, revisions),
});
