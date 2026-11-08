// 接需求时读用户上传的素材（ADR 0024）：canvas 核对是不是这个人的、签发临时下载链接，
// inspector 下载并解析出正文（图片原图留给看图）。
import { UploadLinksResult } from '@oasis/contracts/canvas';
import { MaterialInspectResult } from '@oasis/contracts/inspector';
import type { ServiceClient } from '@oasis/service-kit';

export function createMaterialReader(deps: { canvas: ServiceClient; inspector: ServiceClient }) {
  return async (ownerId: string, ids: string[], requestId: string) => {
    const { uploads } = await deps.canvas.json('POST', '/internal/uploads/links', {
      body: { ownerId, ids },
      schema: UploadLinksResult,
      requestId,
    });
    return deps.inspector.json('POST', '/internal/materials/inspect', {
      body: {
        files: uploads.map((upload) => ({
          uploadId: upload.id,
          name: upload.name,
          size: upload.size,
          sha256: upload.sha256 ?? null,
          url: upload.url,
        })),
      },
      schema: MaterialInspectResult,
      requestId,
    });
  };
}

export type MaterialReader = ReturnType<typeof createMaterialReader>;
