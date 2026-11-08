// 上传素材与运行产出共用解析器；这里只负责所有权、传输边界和来源摘要。
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import type { MaterialInspectBody, MaterialInspectResult } from '@oasis/contracts/harness';
import { readLimited, type ServiceClient } from '@oasis/service-kit';
import { inspectFiles, type InspectionLimits } from './file-inspection.ts';

/** 交给看图检查的图片素材类型和单张上限（和关卡视觉检查的上限一致） */
const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export function createMaterialInspector(canvas: ServiceClient, limits: InspectionLimits) {
  return async (input: MaterialInspectBody): Promise<MaterialInspectResult> => {
    if (!input.ids.length) return { files: [] };
    const { uploads } = await canvas.json('POST', '/internal/uploads/lookup', {
      body: { ownerId: input.ownerId, ids: input.ids },
      schema: UploadLookupResult,
    });
    let remaining = input.maxChars;
    const started = Date.now();
    const files: MaterialInspectResult['files'] = [];
    for (const upload of uploads) {
      const base = {
        uploadId: upload.id,
        name: upload.name,
        sha256: upload.sha256 ?? null,
        text: '',
      };
      const time = limits.totalMs - (Date.now() - started);
      if (upload.size > limits.inputBytes || remaining <= 0 || time <= 0) {
        files.push({
          ...base,
          status: 'partial',
          reason: '素材超过本次解析大小、正文或时间上限，未完整读取',
        });
        continue;
      }
      try {
        const response = await canvas.stream('GET', `/internal/uploads/${upload.id}/content`, {
          signal: AbortSignal.timeout(time),
        });
        if (!response.body) throw new Error('素材内容流缺失');
        const bytes = await readLimited(
          Readable.fromWeb(response.body),
          Math.min(upload.size, limits.inputBytes),
        );
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (bytes.length !== upload.size || (upload.sha256 && sha256 !== upload.sha256))
          throw new Error('素材大小或摘要不符');
        // 图片素材（如批注截图）没有正文可读：原图交给关卡的看图检查，不算没读完
        const mediaType = IMAGE_TYPES[upload.name.split('.').at(-1)?.toLowerCase() ?? ''];
        if (mediaType && bytes.length <= IMAGE_MAX_BYTES) {
          files.push({
            ...base,
            sha256,
            status: 'complete',
            reason: '图片素材，交给看图检查',
            image: { mediaType, base64: bytes.toString('base64') },
          });
          continue;
        }
        const report = await inspectFiles([{ path: upload.name, content: bytes }], remaining, {
          ...limits,
          totalMs: Math.max(1, limits.totalMs - (Date.now() - started)),
        });
        const parsed = report.files[0];
        const reason = parsed?.error ?? parsed?.warning;
        files.push({
          ...base,
          sha256,
          text: parsed?.text ?? '',
          status:
            !parsed || report.truncated || parsed.errorKind === 'incomplete'
              ? 'partial'
              : parsed.error
                ? 'failed'
                : !parsed.text || parsed.warning
                  ? 'unsupported'
                  : 'complete',
          ...(reason || report.truncated
            ? { reason: reason ?? '提取正文已截断，未覆盖完整材料' }
            : {}),
        });
        remaining -= parsed?.text.length ?? 0;
      } catch (error) {
        files.push({
          ...base,
          status: 'failed',
          reason: error instanceof Error ? error.message : '素材读取失败',
        });
      }
    }
    return { files };
  };
}
export type MaterialInspector = ReturnType<typeof createMaterialInspector>;
