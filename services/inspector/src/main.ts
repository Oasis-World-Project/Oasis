// inspector：判断成果的检查服务（ADR 0024）。文件解析、音视频解码、网页的浏览器检查、外站测试、
// 模型预览、用户素材解析都在这里；它不调别的服务、不存东西：要检查的内容由调用方给对象存储的临时下载链接，
// 或直接放在请求里。要开容器的检查（解码、浏览器）由调用方付算力：它先冻结，按这里报回的实际用量结算。
import { createDockerApi, defaultDockerSocket, startService } from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { createBrowserChecks } from './browser/browser-check.ts';
import { createBrowserExecutor } from './browser/executor.ts';
import { inspectorEnv } from './config.ts';
import { createFileCheck } from './service/file-check.ts';
import {
  createModelPosterInspector,
  createModelPreviewInspector,
  type InspectionLimits,
} from './service/file-inspection.ts';
import { sweepLeftovers } from './service/leftovers.ts';
import { createMaterialInspector } from './service/material-inspection.ts';
import { createMediaCheck } from './service/media-check.ts';
import { createSources } from './service/sources.ts';

await startService({
  name: 'inspector',
  env: inspectorEnv,
  routes: (app, { config, logger }) => {
    const limits: InspectionLimits = {
      inputBytes: config.EXTRACT_INPUT_BYTES,
      unzipBytes: config.EXTRACT_UNZIP_BYTES,
      entries: config.EXTRACT_MAX_ENTRIES,
      pages: config.EXTRACT_MAX_PAGES,
      cells: config.EXTRACT_MAX_CELLS,
      pixels: config.EXTRACT_MAX_PIXELS,
      timeoutMs: config.EXTRACT_TIMEOUT_MS,
      totalMs: config.EXTRACT_TOTAL_MS,
      files: config.EXTRACT_MAX_FILES,
    };
    const sources = createSources({
      origins: config.SOURCE_ORIGINS,
      timeoutMs: config.SOURCE_TIMEOUT_MS,
    });
    const docker = createDockerApi(config.DOCKER_SOCKET ?? defaultDockerSocket());
    const stopSweeping = sweepLeftovers(docker, logger);
    app.addHook('onClose', async () => stopSweeping());
    registerRoutes(app, {
      checkFiles: createFileCheck({ sources, limits, maxArchiveBytes: config.SOURCE_MAX_BYTES }),
      checkMedia: createMediaCheck({
        sources,
        docker,
        box: {
          image: config.MEDIA_CHECK_IMAGE,
          memoryMb: config.MEDIA_CHECK_MEMORY_MB,
          pidsLimit: config.MEDIA_CHECK_PIDS_LIMIT,
        },
        limits: {
          files: config.MEDIA_CHECK_MAX_FILES,
          durationMs: config.MEDIA_CHECK_MAX_DURATION_MS,
          maxBytes: config.SOURCE_MAX_BYTES,
        },
        concurrency: config.MEDIA_CHECK_CONCURRENCY,
        sourceTimeoutMs: config.SOURCE_TIMEOUT_MS,
      }),
      browser: createBrowserChecks({
        executor: createBrowserExecutor({
          docker,
          image: config.BROWSER_IMAGE,
          memoryMb: config.BROWSER_MEMORY_MB,
          pidsLimit: config.BROWSER_PIDS_LIMIT,
          appPort: config.BROWSER_APP_PORT,
        }),
        sources,
        websiteOrigins: config.WEBSITE_TEST_ORIGINS,
        maxArchiveBytes: config.SOURCE_MAX_BYTES,
        concurrency: config.BROWSER_CONCURRENCY,
      }),
      inspectMaterials: createMaterialInspector(sources, limits),
      inspectModel: createModelPreviewInspector(),
      inspectPoster: createModelPosterInspector(),
    });
  },
});
