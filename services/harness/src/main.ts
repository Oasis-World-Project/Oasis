// harness：Agent 运行时。唯一接触 DeepSeek Harness 的服务（只在 src/adapter/ 里），
// 每次运行起一个沙箱容器跑 dsh，模型调用经 model-gateway 计费（ADR 0003）。
import { fileURLToPath } from 'node:url';
import { HARNESS_STREAM, TASK_STREAM, TaskDeleted } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createObjectStore,
  createServiceClient,
  ensureStream,
  startEventConsumer,
  startOutboxRelay,
  startService,
  type ObjectStore,
  type ServiceResource,
} from '@oasis/service-kit';
import { SANDBOX_PATHS } from './adapter/dsh.ts';
import { registerRoutes } from './api/routes.ts';
import { harnessEnv } from './config.ts';
import { createDockerApi, defaultDockerSocket } from './executor/docker-api.ts';
import { createDockerExecutor, type Executor } from './executor/executor.ts';
import { createPreviewExecutor } from './executor/preview-executor.ts';
import { createPreviewRepo } from './repo/preview-repo.ts';
import { createRunsRepo } from './repo/runs-repo.ts';
import { createRunService, type RunService } from './service/run-service.ts';
import { createPreviewService, type PreviewService } from './service/preview-service.ts';
import { createMaterialInspector } from './service/material-inspection.ts';

let executor: Executor;
let store: ObjectStore;
let runs: RunService | undefined;
let previews: PreviewService | undefined;

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
      multipartMaxAgeMs: config.S3_MULTIPART_MAX_AGE_MS,
      logger: ctx.logger,
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
      mediaCheck: {
        files: config.MEDIA_CHECK_MAX_FILES,
        timeoutMs: config.MEDIA_CHECK_TIMEOUT_MS,
        durationMs: config.MEDIA_CHECK_MAX_DURATION_MS,
        maxBytes: config.OUTPUT_MAX_BYTES,
      },
    });
    // 就绪 = Docker 可用、沙箱镜像和网络都在；关闭时先让进行中的运行收尾
    const sandboxes: ServiceResource = {
      name: 'sandboxes',
      ready: () => executor.check(),
      close: async () => {
        await previews?.close();
        await runs?.stopAll();
      },
    };
    // 任务被删除（用户删除或被新版替换）：停掉它的预览，删掉运行存档和记录（ADR 0012）
    const taskDeleted = startEventConsumer({
      connection: eventBus.connection,
      stream: TASK_STREAM,
      durable: 'harness-task-deleted',
      filterSubject: TaskDeleted.type,
      logger: ctx.logger,
      handle: async (envelope) => {
        const { taskId } = TaskDeleted.data.parse(envelope.data);
        // 服务还在启动（接口层还没建好）：抛出让事件稍后重投
        if (!runs || !previews) throw new Error('harness 还没就绪');
        await previews.stopTask(taskId);
        if (!(await runs.purgeTask(taskId))) throw new Error('任务还有没结束的运行，稍后再清理');
      },
    });
    return { postgres, eventBus, outbox, objectStore: objects.resource, sandboxes, taskDeleted };
  },
  routes: async (app, { config, resources, logger, name }) => {
    runs = createRunService({
      repo: createRunsRepo(resources.postgres.pool),
      executor,
      store,
      modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
        timeoutMs: 10_000,
      }),
      canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 60_000 }),
      materialsMaxBytes: config.MATERIALS_MAX_BYTES,
      transferTimeoutMs: config.FILE_TRANSFER_TIMEOUT_MS,
      modelBaseUrl: config.SANDBOX_MODEL_BASE_URL,
      packages: {
        egressProxy: config.SANDBOX_EGRESS_PROXY,
        npmRegistry: config.SANDBOX_NPM_REGISTRY,
        pipIndexUrl: config.SANDBOX_PIP_INDEX_URL,
      },
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      batchEnv: Object.fromEntries(
        Object.entries(config)
          .filter(([key]) => key.startsWith('OASIS_BATCH_'))
          .map(([key, value]) => [key, String(value)]),
      ),
      timeoutMs: config.RUN_TIMEOUT_MS,
      cores: config.SANDBOX_CPUS,
      outputMaxBytes: config.OUTPUT_MAX_BYTES,
      inspectionLimits: {
        inputBytes: config.EXTRACT_INPUT_BYTES,
        unzipBytes: config.EXTRACT_UNZIP_BYTES,
        entries: config.EXTRACT_MAX_ENTRIES,
        pages: config.EXTRACT_MAX_PAGES,
        cells: config.EXTRACT_MAX_CELLS,
        pixels: config.EXTRACT_MAX_PIXELS,
        timeoutMs: config.EXTRACT_TIMEOUT_MS,
        totalMs: config.EXTRACT_TOTAL_MS,
        files: config.EXTRACT_MAX_FILES,
      },
      serviceName: name,
      logger,
    });
    previews = createPreviewService({
      repo: createPreviewRepo(resources.postgres.pool),
      executor: createPreviewExecutor({
        docker: createDockerApi(config.DOCKER_SOCKET ?? defaultDockerSocket()),
        image: config.PREVIEW_IMAGE,
        cpus: config.PREVIEW_CPUS,
        memoryMb: config.PREVIEW_MEMORY_MB,
        pidsLimit: config.PREVIEW_PIDS_LIMIT,
        appPort: config.PREVIEW_APP_PORT,
      }),
      canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 60_000 }),
      modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
        timeoutMs: 10_000,
      }),
      logger,
      runs,
      cpus: config.PREVIEW_CPUS,
      maxMs: config.PREVIEW_MAX_MS,
      idleMs: config.PREVIEW_IDLE_MS,
    });
    registerRoutes(
      app,
      runs,
      previews,
      createMaterialInspector(
        createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: config.EXTRACT_TOTAL_MS }),
        {
          inputBytes: config.EXTRACT_INPUT_BYTES,
          unzipBytes: config.EXTRACT_UNZIP_BYTES,
          entries: config.EXTRACT_MAX_ENTRIES,
          pages: config.EXTRACT_MAX_PAGES,
          cells: config.EXTRACT_MAX_CELLS,
          pixels: config.EXTRACT_MAX_PIXELS,
          timeoutMs: config.EXTRACT_TIMEOUT_MS,
          totalMs: config.EXTRACT_TOTAL_MS,
          files: config.EXTRACT_MAX_FILES,
        },
      ),
    );
    // 接管上次进程遗留的运行；Docker 暂时不可用也不阻止启动（/ready 会显示 sandboxes 失败）
    await runs.recover().catch((err: unknown) => logger.warn({ err }, '清理遗留运行失败'));
    await previews.recover().catch((err: unknown) => logger.warn({ err }, '清理遗留预览失败'));
  },
});
