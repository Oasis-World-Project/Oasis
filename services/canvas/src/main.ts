// canvas：画布。存用户上传的素材；对话里一轮结束时把 AI 做出的文件登记成成果，给前端列出、预览、下载。
import { fileURLToPath } from 'node:url';
import {
  createObjectStore,
  createPostgres,
  createServiceClient,
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
    const postgres = createPostgres(config.DATABASE_URL, ctx.logger);
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
    artifacts = createArtifactService({
      repo: createArtifactsRepo(postgres.pool),
      store,
      // 复制成果文件可能要一会儿
      harness: createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 60_000 }),
      logger: ctx.logger,
      maxFileBytes: config.UPLOAD_MAX_BYTES,
      transferTimeoutMs: config.FILE_TRANSFER_TIMEOUT_MS,
    });
    return { postgres, objectStore: objects.resource };
  },
  routes: (app, { config, resources, logger }) => {
    const uploads = createUploadService({
      repo: createUploadsRepo(resources.postgres.pool),
      store,
      logger,
    });
    uploads.start();
    app.addHook('onClose', () => {
      uploads.close();
    });
    registerRoutes(
      app,
      {
        uploads,
        artifacts,
        store,
        inspector: createServiceClient('inspector', config.INSPECTOR_URL, { timeoutMs: 60_000 }),
        ...(config.MODEL_GATEWAY_URL
          ? {
              // 开数字人会话要在 LiveAvatar 上建好几样东西，从国内网络发出去会慢
              modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
                timeoutMs: 60_000,
              }),
            }
          : {}),
      },
      {
        maxBytes: config.UPLOAD_MAX_BYTES,
        uploadConcurrency: config.UPLOAD_CONCURRENCY,
        transferTimeoutMs: config.FILE_TRANSFER_TIMEOUT_MS,
        preview: {
          inputBytes: config.PREVIEW_MAX_BYTES,
          unzipBytes: config.PREVIEW_UNZIP_MAX_BYTES,
          entries: config.PREVIEW_MAX_ENTRIES,
          timeoutMs: config.PREVIEW_TIMEOUT_MS,
          concurrency: config.PREVIEW_CONCURRENCY,
        },
        archive: { bytes: config.ARCHIVE_MAX_BYTES, files: config.ARCHIVE_MAX_FILES },
      },
    );
  },
});
