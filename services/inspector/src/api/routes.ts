// inspector 只有内部接口（gateway 不转发 /internal）：task 的关卡、model-gateway 的 app.check 和外站测试、
// canvas 的模型预览、conversation 的素材解析调它（ADR 0024）。
import {
  ApplicationCheckBody,
  ApplicationFilesCheckBody,
  FilesCheckBody,
  MaterialsInspectBody,
  MediaCheckBody,
  WebsiteCheckBody,
} from '@oasis/contracts/inspector';
import { ModelInspectionBody, MODEL_PREVIEW_LIMITS } from '@oasis/contracts/model-preview';
import { parseWith, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { BrowserChecks } from '../browser/browser-check.ts';
import type { createFileCheck } from '../service/file-check.ts';
import type {
  createModelPosterInspector,
  createModelPreviewInspector,
} from '../service/file-inspection.ts';
import type { createMaterialInspector } from '../service/material-inspection.ts';
import type { createMediaCheck } from '../service/media-check.ts';

/** 模型和封面以 base64 放在请求里 */
const MODEL_BODY = { bodyLimit: Math.ceil(MODEL_PREVIEW_LIMITS.bytes / 3) * 4 + 1000 };
/** 节点自查的应用文件随调用带来（沙箱那边限 25 MB，base64 后加上包装） */
const APP_FILES_BODY = { bodyLimit: 48 * 1024 * 1024 };

/** 调用方断开（用户停止节点、任务被删）时随之停下 */
function abortOnClose(reply: {
  raw: { on(event: 'close', listener: () => void): unknown; writableEnded: boolean };
}): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}

export function registerRoutes(
  app: ServiceApp,
  deps: {
    checkFiles: ReturnType<typeof createFileCheck>;
    checkMedia: ReturnType<typeof createMediaCheck>;
    browser: BrowserChecks;
    inspectMaterials: ReturnType<typeof createMaterialInspector>;
    inspectModel: ReturnType<typeof createModelPreviewInspector>;
    inspectPoster: ReturnType<typeof createModelPosterInspector>;
  },
): void {
  /** 关卡：解析一次运行产出包里的这些文件 */
  app.post('/internal/files/check', async (request, reply) => {
    const { source, paths, maxChars } = parseWith(FilesCheckBody, request.body);
    return deps.checkFiles({ url: source.url, paths, maxChars }, abortOnClose(reply));
  });

  /** 关卡：音视频、平台工程、字幕能不能完整解码（不联网的检查容器；算力由调用方按报回的用量结算） */
  app.post('/internal/media/check', async (request, reply) =>
    deps.checkMedia(parseWith(MediaCheckBody, request.body), abortOnClose(reply)),
  );

  /** 关卡：运行产出包里的网页在检查浏览器里跑一遍（不设时限，调用方断开时停下） */
  app.post('/internal/applications/check', async (request, reply) =>
    deps.browser.checkOutputs(parseWith(ApplicationCheckBody, request.body), abortOnClose(reply)),
  );

  /** 节点自查（app.check）：out/<dir> 的文件随调用带来，跑和关卡同一套检查 */
  app.post('/internal/applications/check-files', APP_FILES_BODY, async (request, reply) =>
    deps.browser.checkFiles(
      parseWith(ApplicationFilesCheckBody, request.body),
      abortOnClose(reply),
    ),
  );

  /** 外站测试（website.test）：只访问放行来源的 HTTPS 页面 */
  app.post('/internal/websites/check', async (request, reply) =>
    deps.browser.checkWebsite(parseWith(WebsiteCheckBody, request.body), abortOnClose(reply)),
  );

  /** 接需求时读用户上传的素材 */
  app.post('/internal/materials/inspect', async (request) =>
    deps.inspectMaterials(parseWith(MaterialsInspectBody, request.body)),
  );

  /** 画布的模型预览：模型能不能直接显示（几何、贴图、动画上限） */
  app.post('/internal/models/inspect', MODEL_BODY, (request) =>
    deps.inspectModel(parseWith(ModelInspectionBody, request.body)),
  );
  app.post('/internal/models/poster', MODEL_BODY, (request) =>
    deps.inspectPoster(
      parseWith(
        ModelInspectionBody.extend({
          name: z.enum(['poster.png', 'poster.jpg', 'poster.jpeg', 'poster.webp']),
        }),
        request.body,
      ),
    ),
  );
}
