// task：工作流控制面（ADR 0004）。管任务的节点图、状态和调度；节点在 harness 里执行，
// 收到 harness.run.finished 就推进，并定时和 harness 对账。
import { fileURLToPath } from 'node:url';
import { HARNESS_STREAM, RunFinished } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  startEventConsumer,
  startService,
  type ServiceResource,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { taskEnv } from './config.ts';
import { createTaskStore } from './repo/task-store.ts';
import { createWorkflowService, type WorkflowService } from './service/workflow-service.ts';

let workflows: WorkflowService;

await startService({
  name: 'task',
  env: taskEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config, logger } = ctx;
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    workflows = createWorkflowService({
      store: createTaskStore(postgres.pool),
      harness: createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 15_000 }),
      maxParallel: config.MAX_PARALLEL_NODES,
      maxRetries: config.MAX_NODE_RETRIES,
      logger,
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
    return { postgres, eventBus, runFinished, reconciler };
  },
  routes: (app) => registerRoutes(app, workflows),
});
