// 格式解析在独立 worker 中完成；逐文件错误、资源上限和总字符上限对调用方可见。
import { Worker } from 'node:worker_threads';
import type { RunTextsBody } from '@oasis/contracts/harness';

export interface InspectionLimits {
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
export type InspectedFile = RunTextsBody['files'][number];

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
): Promise<RunTextsBody> {
  const result: RunTextsBody = { files: [], truncated: false };
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
