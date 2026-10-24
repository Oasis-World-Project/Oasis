// canvas：画布。存用户上传的素材；任务完成时把成果登记进画布，给前端列出、预览、下载（ADR 0007）。
import { fileURLToPath } from 'node:url';
import { TASK_STREAM, TaskStatusChanged } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createObjectStore,
  createServiceClient,
  startEventConsumer,
  startService,
  type ObjectStore,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { canvasEnv } from './config.ts';
import { createArtifactsRepo } from './repo/artifacts-repo.ts';
import { createUploadsRepo } from './repo/uploads-repo.ts';
import { createArtifactService, type ArtifactService } from './service/artifact-service.ts';
import { createUploadService } from './service/upload-service.ts';

let store: ObjectStore;
let artifacts: ArtifactService;

await startService({
  name: 'canvas',
  env: canvasEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config } = ctx;
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    const objects = createObjectStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      accessKey: config.S3_ACCESS_KEY,
      secretKey: config.S3_SECRET_KEY,
      bucket: config.S3_BUCKET,
    });
    await objects.ensureBucket();
    store = objects.store;
    artifacts = createArtifactService({
      repo: createArtifactsRepo(postgres.pool),
      store,
      // 复制成果文件可能要一会儿
      task: createServiceClient('task', config.TASK_URL, { timeoutMs: 60_000 }),
      logger: ctx.logger,
    });
    // 任务完成 → 把成果登记进画布
    const taskStatus = startEventConsumer({
      connection: eventBus.connection,
      stream: TASK_STREAM,
      durable: 'canvas-task-succeeded',
      filterSubject: TaskStatusChanged.type,
      logger: ctx.logger,
      handle: (envelope) => artifacts.onTaskStatus(TaskStatusChanged.data.parse(envelope.data)),
    });
    return { postgres, eventBus, objectStore: objects.resource, taskStatus };
  },
  routes: (app, { config, resources }) => {
    registerRoutes(
      app,
      {
        uploads: createUploadService({ repo: createUploadsRepo(resources.postgres.pool), store }),
        artifacts,
        store,
      },
      { maxBytes: config.UPLOAD_MAX_BYTES },
    );
  },
});
