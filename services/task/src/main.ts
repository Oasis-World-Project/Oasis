// task：工作流控制面（ADR 0004）。管任务的节点图、状态和调度；节点在 harness 里执行，
// 收到 harness.run.finished 就推进（讨论下一轮、过关卡），收到 model-gateway.call.settled 就累加花费，
// 并定时和 harness 对账。
import { fileURLToPath } from 'node:url';
import {
  CallSettled,
  HARNESS_STREAM,
  MODEL_GATEWAY_STREAM,
  RunFinished,
} from '@oasis/contracts/events';
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
import { createGate } from './service/gate.ts';
import { createWorkflowService, type WorkflowService } from './service/workflow-service.ts';

let workflows: WorkflowService;

await startService({
  name: 'task',
  env: taskEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config, logger } = ctx;
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    const harness = createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 15_000 });
    workflows = createWorkflowService({
      store: createTaskStore(postgres.pool),
      harness,
      gate: createGate({
        harness,
        modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
          timeoutMs: 60_000,
        }),
        model: config.GATE_MODEL,
        threshold: config.GATE_THRESHOLD,
        logger,
      }),
      maxParallel: config.MAX_PARALLEL_NODES,
      maxRetries: config.MAX_NODE_RETRIES,
      maxReworks: config.MAX_NODE_REWORKS,
      budgetMultiplier: config.BUDGET_MULTIPLIER,
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
    // 属于任务的模型调用结算了：累加花费，超过上限时暂停任务
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
    return { postgres, eventBus, runFinished, callSettled, reconciler };
  },
  routes: (app) => registerRoutes(app, workflows),
});
