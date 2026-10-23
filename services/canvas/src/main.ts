// canvas：画布。现在存用户上传的素材（ADR 0007）；5.5c 起登记任务的成果、在画布里预览。
import { fileURLToPath } from 'node:url';
import {
  connectPostgresAndEventBus,
  createObjectStore,
  startService,
  type ObjectStore,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { canvasEnv } from './config.ts';
import { createUploadsRepo } from './repo/uploads-repo.ts';
import { createUploadService } from './service/upload-service.ts';

let store: ObjectStore;

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
    return { postgres, eventBus, objectStore: objects.resource };
  },
  routes: (app, { config, resources }) => {
    registerRoutes(
      app,
      createUploadService({ repo: createUploadsRepo(resources.postgres.pool), store }),
      { maxBytes: config.UPLOAD_MAX_BYTES },
    );
  },
});
