// 格式解析在独立 worker 中完成；逐文件错误、资源上限和总字符上限对调用方可见。
import { Worker } from 'node:worker_threads';
import type { InspectedFile, InspectedFiles } from '@oasis/contracts/inspector';
import {
  GeometryPreviewReport,
  MODEL_PREVIEW_LIMITS,
  type ModelInspectionResult,
} from '@oasis/contracts/model-preview';
import { createHash } from 'node:crypto';
import { HttpError } from '@oasis/service-kit';

export interface InspectionLimits {
  modelPreview?: boolean;
  inputBytes: number;
  unzipBytes: number;
  entries: number;
  pages: number;
  cells: number;
  pixels: number;
  timeoutMs: number;
  totalMs: number;
  files: number;
}
export const defaultInspectionLimits: InspectionLimits = {
  inputBytes: 20 * 1024 * 1024,
  unzipBytes: 50 * 1024 * 1024,
  entries: 2000,
  pages: 200,
  cells: 20000,
  pixels: 25000000,
  timeoutMs: 10000,
  totalMs: 30000,
  files: 1000,
};

async function inspect(
  file: { path: string; content: Buffer },
  limits: InspectionLimits,
  maxChars: number,
): Promise<InspectedFile & { truncated?: boolean }> {
  if (!file.content.length) return { path: file.path, text: '', valid: false, error: '文件为空' };
  if (file.content.length > limits.inputBytes)
    return {
      path: file.path,
      text: '',
      valid: false,
      error: '文件超过解析大小上限',
      errorKind: 'incomplete',
    };
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((resolve) => {
    const worker = new Worker(new URL(`./file-inspection-worker.${extension}`, import.meta.url), {
      workerData: { path: file.path, content: file.content, limits, maxChars },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    let finished = false;
    const finish = (result: InspectedFile & { truncated?: boolean }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const fail = (error: string) =>
      finish({ path: file.path, text: '', valid: false, error, errorKind: 'incomplete' });
    const timer = setTimeout(() => fail('文件解析超时，未完成检查'), limits.timeoutMs);
    worker.once('message', finish);
    worker.once('error', () => fail('文件解析进程出错，未完成检查'));
    worker.once('exit', () => {
      if (!finished) fail('文件解析进程提前退出');
    });
  });
}

export async function inspectFiles(
  files: { path: string; content: Buffer }[],
  maxChars: number,
  limits = defaultInspectionLimits,
): Promise<InspectedFiles> {
  const result: InspectedFiles = { files: [], truncated: false };
  let left = maxChars;
  const start = Date.now();
  for (const [index, file] of files.entries()) {
    const remaining = limits.totalMs - (Date.now() - start);
    if (index >= limits.files || remaining <= 0) {
      result.truncated = true;
      // 不给遗漏文件制造“有效”结论；关卡可由缺失报告识别未检查。
      break;
    }
    const { truncated, ...checked } = await inspect(
      file,
      { ...limits, timeoutMs: Math.min(limits.timeoutMs, remaining) },
      Math.max(0, left),
    );
    result.files.push({ ...checked, ...(truncated ? { truncated: true } : {}) });
    left -= checked.text.length;
    if (truncated) result.truncated = true;
  }
  return result;
}

export function createModelPreviewInspector() {
  let active = 0;
  return async (input: {
    contentBase64: string;
    sha256: string;
  }): Promise<import('zod').infer<typeof ModelInspectionResult>> => {
    if (active >= 2) throw new HttpError(503, 'model_preview_busy', '模型预览检查正忙');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (
      bytes.length > MODEL_PREVIEW_LIMITS.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256
    )
      throw new HttpError(422, 'model_preview_hash', '模型大小或摘要不符');
    active++;
    try {
      const report = await inspectFiles([{ path: 'model.glb', content: bytes }], 16000, {
        ...defaultInspectionLimits,
        inputBytes: MODEL_PREVIEW_LIMITS.bytes,
        pixels: MODEL_PREVIEW_LIMITS.texturePixels,
        modelPreview: true,
      });
      const file = report.files[0];
      if (!file?.valid || file.error || report.truncated || file.truncated)
        return {
          status: file?.errorKind === 'invalid' ? 'invalid' : 'unsupported',
          sha256: input.sha256,
          reason: (file?.error ?? '模型检查未完成').slice(0, 1000),
        };
      return {
        status: 'ready',
        sha256: input.sha256,
        report: GeometryPreviewReport.parse(JSON.parse(file.text)),
      };
    } finally {
      active--;
    }
  };
}

export function createModelPosterInspector() {
  let active = 0;
  return async (input: { name: string; sha256: string; contentBase64: string }) => {
    if (active >= 2) throw new HttpError(503, 'model_preview_busy', '封面检查正忙');
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (
      bytes.length > MODEL_PREVIEW_LIMITS.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== input.sha256
    )
      throw new HttpError(422, 'model_preview_hash', '封面大小或摘要不符');
    active++;
    try {
      const result = await inspectFiles([{ path: input.name, content: bytes }], 100, {
        ...defaultInspectionLimits,
        pixels: MODEL_PREVIEW_LIMITS.texturePixels,
      });
      const file = result.files[0];
      if (
        !file?.valid ||
        !file.width ||
        !file.height ||
        file.width > MODEL_PREVIEW_LIMITS.textureSide ||
        file.height > MODEL_PREVIEW_LIMITS.textureSide
      )
        throw new HttpError(422, 'model_poster_invalid', '封面格式或解码资源不符合预览限制');
      return { sha256: input.sha256, width: file.width, height: file.height };
    } finally {
      active--;
    }
  };
}
