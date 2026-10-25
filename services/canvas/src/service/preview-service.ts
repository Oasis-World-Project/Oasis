// 用户文件在有内存和时间上限的 worker 中转换；不写磁盘、不读取 URL。
import { Worker } from 'node:worker_threads';
import { FilePreviewBody } from '@oasis/contracts/canvas';
import { HttpError } from '@oasis/service-kit';

export const defaultPreviewLimits = {
  inputBytes: 20 * 1024 * 1024,
  unzipBytes: 50 * 1024 * 1024,
  entries: 2000,
  timeoutMs: 10_000,
  concurrency: 2,
};
export type PreviewLimits = typeof defaultPreviewLimits;

export function createPreviewService(limits: PreviewLimits = defaultPreviewLimits) {
  let active = 0;
  return async (name: string, content: Buffer): Promise<FilePreviewBody> => {
    if (!content.length || content.length > limits.inputBytes)
      throw new HttpError(413, 'preview_size', '文件为空或超过预览大小上限');
    if (active >= limits.concurrency)
      throw new HttpError(503, 'preview_busy', '预览转换正忙，请稍后重试');
    active++;
    try {
      return await new Promise((resolve, reject) => {
        const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
        const worker = new Worker(new URL(`./preview-worker.${ext}`, import.meta.url), {
          workerData: { name, content, limits },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        });
        let done = false;
        const finish = (result?: unknown, error?: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void worker.terminate();
          const parsed = FilePreviewBody.safeParse(result);
          if (error || !parsed.success)
            reject(new HttpError(422, 'preview_failed', error ?? '文件预览转换失败，请下载查看'));
          else resolve(parsed.data);
        };
        const timer = setTimeout(() => finish(undefined, '文件预览转换超时'), limits.timeoutMs);
        worker.once('message', (message: { result?: unknown; error?: string }) =>
          finish(message.result, message.error),
        );
        worker.once('error', () => finish(undefined, '文件预览进程出错'));
        worker.once('exit', () => finish(undefined, '文件预览进程提前退出'));
      });
    } finally {
      active--;
    }
  };
}
