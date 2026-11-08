// inspector：判断成果的检查服务（ADR 0024）。文件解析、模型预览、用户素材解析都在这里；
// 它不调别的服务、不存东西：要检查的内容由调用方给对象存储的临时下载链接，或直接放在请求里。
import { startService } from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { inspectorEnv } from './config.ts';
import { createFileCheck } from './service/file-check.ts';
import {
  createModelPosterInspector,
  createModelPreviewInspector,
  type InspectionLimits,
} from './service/file-inspection.ts';
import { createMaterialInspector } from './service/material-inspection.ts';
import { createSources } from './service/sources.ts';

await startService({
  name: 'inspector',
  env: inspectorEnv,
  routes: (app, { config }) => {
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
    registerRoutes(app, {
      checkFiles: createFileCheck({ sources, limits, maxArchiveBytes: config.SOURCE_MAX_BYTES }),
      inspectMaterials: createMaterialInspector(sources, limits),
      inspectModel: createModelPreviewInspector(),
      inspectPoster: createModelPosterInspector(),
    });
  },
});
