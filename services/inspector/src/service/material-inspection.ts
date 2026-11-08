// 用户上传的素材（ADR 0024）：canvas 核对过所有权、签发了临时下载链接；这里有界下载、
// 核对大小和摘要，再用和运行产出同一套解析器读出正文。图片原图交给关卡的看图检查。
import { createHash } from 'node:crypto';
import type { MaterialInspectResult, MaterialsInspectBody } from '@oasis/contracts/inspector';
import { readLimited } from '@oasis/service-kit';
import { inspectFiles, type InspectionLimits } from './file-inspection.ts';
import type { Sources } from './sources.ts';

/** 交给看图检查的图片素材类型和单张上限（和关卡视觉检查的上限一致） */
const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

type Input = Required<Pick<MaterialsInspectBody, 'files' | 'maxChars'>>;

export function createMaterialInspector(sources: Sources, limits: InspectionLimits) {
  return async (input: Input): Promise<MaterialInspectResult> => {
    let remaining = input.maxChars;
    const started = Date.now();
    const files: MaterialInspectResult['files'] = [];
    for (const upload of input.files) {
      const base = {
        uploadId: upload.uploadId,
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
        const bytes = await readLimited(
          await sources.open(upload.url, AbortSignal.timeout(time)),
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
