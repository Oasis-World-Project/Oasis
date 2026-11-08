// 关卡的文件解析（ADR 0017、0024）：读一次运行的产出包（harness 签发的临时链接），
// 只解析要的那几个文件，报告能不能用、尺寸和正文；总长、文件数、总时长超了就截断并标出来。
import type { InspectedFiles } from '@oasis/contracts/inspector';
import { readLimited, scanArchive } from '@oasis/service-kit';
import { inspectFiles, type InspectionLimits } from './file-inspection.ts';
import type { Sources } from './sources.ts';

export function createFileCheck(deps: {
  sources: Sources;
  limits: InspectionLimits;
  /** 产出包的大小上限 */
  maxArchiveBytes: number;
}) {
  const { limits } = deps;
  return async (
    input: { url: string; paths: string[]; maxChars: number },
    signal?: AbortSignal,
  ): Promise<InspectedFiles> => {
    const result: InspectedFiles = { files: [], truncated: false };
    const wanted = new Set(input.paths);
    if (!wanted.size) return result;
    const started = Date.now();
    let left = input.maxChars;
    await scanArchive(
      await deps.sources.open(input.url, signal),
      deps.maxArchiveBytes,
      async (path, size, stream) => {
        if (!wanted.has(path)) return;
        if (result.files.length >= limits.files || Date.now() - started > limits.totalMs) {
          result.truncated = true;
          return;
        }
        if (size > limits.inputBytes) {
          result.files.push({
            path,
            text: '',
            valid: false,
            error: '文件超过解析大小上限',
            errorKind: 'incomplete',
          });
          return;
        }
        const checked = await inspectFiles(
          [{ path, content: await readLimited(stream, limits.inputBytes) }],
          left,
          limits,
        );
        result.files.push(...checked.files);
        result.truncated ||= checked.truncated;
        left -= checked.files.reduce((sum, file) => sum + file.text.length, 0);
      },
    );
    return result;
  };
}
