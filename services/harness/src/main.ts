// harness：Agent 运行时。唯一接触 DeepSeek Harness 的服务（只在 src/adapter/ 里），
// 每次运行起一个沙箱容器跑 dsh，模型调用经 model-gateway 计费（ADR 0003）。
import { fileURLToPath } from 'node:url';
import { HARNESS_STREAM } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  ensureStream,
  startOutboxRelay,
  startService,
  type ServiceResource,
} from '@oasis/service-kit';
import { SANDBOX_PATHS } from './adapter/dsh.ts';
import { registerRoutes } from './api/routes.ts';
import { harnessEnv } from './config.ts';
import { createDockerApi, defaultDockerSocket } from './executor/docker-api.ts';
import { createDockerExecutor, type Executor } from './executor/executor.ts';
import { createObjectStore, type ObjectStore } from './repo/object-store.ts';
import { createRunsRepo } from './repo/runs-repo.ts';
import { createRunService, type RunService } from './service/run-service.ts';

let executor: Executor;
let store: ObjectStore;
let runs: RunService | undefined;

await startService({
  name: 'harness',
  env: harnessEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config } = ctx;
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    await ensureStream(eventBus.connection, HARNESS_STREAM);
    const outbox = startOutboxRelay({
      pool: postgres.pool,
      connection: eventBus.connection,
      logger: ctx.logger,
    });

    const objects = createObjectStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      bucket: config.S3_BUCKET,
    });
    await objects.ensureBucket();
    store = objects.store;

    executor = createDockerExecutor({
      docker: createDockerApi(config.DOCKER_SOCKET ?? defaultDockerSocket()),
      image: config.SANDBOX_IMAGE,
      network: config.SANDBOX_NETWORK,
      cpus: config.SANDBOX_CPUS,
      memoryMb: config.SANDBOX_MEMORY_MB,
      pidsLimit: config.SANDBOX_PIDS_LIMIT,
      workdir: SANDBOX_PATHS.workdir,
    });
    // 就绪 = Docker 可用、沙箱镜像和网络都在；关闭时先让进行中的运行收尾
    const sandboxes: ServiceResource = {
      name: 'sandboxes',
      ready: () => executor.check(),
      close: async () => runs?.stopAll(),
    };
    return { postgres, eventBus, outbox, objectStore: objects.resource, sandboxes };
  },
  routes: async (app, { config, resources, logger, name }) => {
    runs = createRunService({
      repo: createRunsRepo(resources.postgres.pool),
      executor,
      store,
      modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
        timeoutMs: 10_000,
      }),
      modelBaseUrl: config.SANDBOX_MODEL_BASE_URL,
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      timeoutMs: config.RUN_TIMEOUT_MS,
      outputMaxBytes: config.OUTPUT_MAX_BYTES,
      serviceName: name,
      logger,
    });
    registerRoutes(app, runs);
    // 接管上次进程遗留的运行；Docker 暂时不可用也不阻止启动（/ready 会显示 sandboxes 失败）
    await runs.recover().catch((err: unknown) => logger.warn({ err }, '清理遗留运行失败'));
  },
});
