// 读运行的产出和过程：运行事件、文字类产出（给关卡检查）、单个文件、音视频受信检查报告、
// 运行中沙箱里的当前文件（节点自查 app.check 用）。
import {
  AudioCheckResult,
  VideoCheckResult,
  type RunEventBody,
  type RunTextsBody,
} from '@oasis/contracts/harness';
import { contentTypeOf, HttpError } from '@oasis/service-kit';
import { SANDBOX_PATHS } from '../../adapter/dsh.ts';
import { archiveFile, extractFiles, readLimited, scanArchive } from '../../executor/tar.ts';
import { defaultInspectionLimits, inspectFiles } from '../file-inspection.ts';
import { audioPath, isPrivateOutput, videoPath, type RunContext } from './shared.ts';

/** 读对象存储里的受信检查报告；没有（历史运行、检查没做完）时返回 undefined */
async function readReport<T>(
  read: () => Promise<Buffer>,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  try {
    return parse(JSON.parse((await read()).toString('utf8')));
  } catch {
    return undefined;
  }
}

export function createOutputs(ctx: RunContext) {
  const { deps, owned } = ctx;
  const { repo, executor, store } = deps;

  async function checkedMedia(
    id: string,
    payerId: string,
    taskId: string,
    kind: 'audio' | 'video',
  ) {
    const row = await owned(id);
    if (row.payerId !== payerId || row.taskId !== taskId)
      throw new HttpError(404, 'run_not_found', '没有这次运行');
    const expected = row.outputs.filter((file) =>
      (kind === 'audio' ? audioPath : videoPath).test(file.path),
    );
    const report = await readReport(
      () => store.get(`runs/${id}/${kind}-check.json`),
      (value) => VideoCheckResult.parse(value),
    );
    if (!report) return { files: [], unchecked: expected.map((file) => file.path) };
    const files = report.files.filter((file) =>
      expected.some(
        (output) =>
          output.path === file.path &&
          output.size === file.size &&
          output.sha256 === file.sha256 &&
          Boolean(file.sha256),
      ),
    );
    return {
      files,
      unchecked: expected
        .filter((output) => !files.some((file) => file.path === output.path))
        .map((file) => file.path),
    };
  }

  return {
    /**
     * 运行中沙箱里 out/<dir> 的当前文件（节点自查 app.check 用，ADR 0017）：只给这次运行的付款人和任务，
     * 运行结束后读不到（成果以归档为准）。
     */
    liveFiles: async (input: { runId: string; payerId: string; taskId: string; dir: string }) => {
      const row = await owned(input.runId);
      if (row.payerId !== input.payerId || row.taskId !== input.taskId)
        throw new HttpError(404, 'run_not_found', '没有这次运行');
      if (row.status !== 'running' || !executor.readStoredArchive)
        throw new HttpError(409, 'run_not_running', '只能检查正在运行的节点的成果');
      const stream = await executor.readStoredArchive(
        input.runId,
        `${SANDBOX_PATHS.outputs}/${input.dir}`,
      );
      if (!stream) throw new HttpError(404, 'dir_not_found', `out/${input.dir} 不存在`);
      return extractFiles(await readLimited(stream, 100 * 1024 * 1024 + 1024 * 1024));
    },

    async events(id: string, afterSeq: number, limit: number): Promise<RunEventBody[]> {
      await owned(id);
      const rows = await repo.listEvents(id, afterSeq, limit);
      return rows.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        data: e.data.status === 'admitted' && e.seq === 0 ? { status: 'admitted' } : e.data,
        createdAt: e.createdAt.toISOString(),
      }));
    },

    /** 文字类产出（给关卡检查用）：按路径顺序读，总长超过 maxChars 就截断 */
    async texts(id: string, maxChars: number, paths?: string[]): Promise<RunTextsBody> {
      const row = await owned(id);
      if (!row.outputKey) return { files: [], truncated: false };
      const result: RunTextsBody = { files: [], truncated: false };
      const limits = deps.inspectionLimits ?? defaultInspectionLimits;
      const started = Date.now();
      let left = maxChars;
      // 没有受信报告（历史运行、检查没做完）时保留未检查
      const audio = await readReport(
        () => store.get(`runs/${id}/audio-check.json`),
        (value) => AudioCheckResult.parse(value),
      );
      const video = await readReport(
        () => store.get(`runs/${id}/video-check.json`),
        (value) => VideoCheckResult.parse(value),
      );
      await scanArchive(
        await store.read(row.outputKey),
        deps.outputMaxBytes,
        async (path, size, stream) => {
          if (isPrivateOutput(path) || (paths !== undefined && !paths.includes(path))) return;
          if (result.files.length >= limits.files || Date.now() - started > limits.totalMs) {
            result.truncated = true;
            return;
          }
          if (audioPath.test(path) || videoPath.test(path)) {
            const reports = videoPath.test(path) ? video : audio;
            const checked = reports?.files.find(
              (file) =>
                file.path === path &&
                file.size === size &&
                file.sha256 === row.outputs.find((output) => output.path === path)?.sha256 &&
                Boolean(file.sha256),
            );
            result.files.push({
              path,
              valid: checked?.valid ?? false,
              ...(checked?.valid
                ? {
                    evidenceScope: videoPath.test(path)
                      ? ('decoded-video' as const)
                      : ('decoded-audio' as const),
                  }
                : {}),
              text: checked ? JSON.stringify(checked) : '',
              ...(checked?.error
                ? { error: checked.error }
                : {
                    warning: checked
                      ? videoPath.test(path)
                        ? '视频/工程/字幕已完成受信结构检查；画面、音画语义及 Shotcut 重导出仍需核对'
                        : '音频已探测并解码；发音、歌词和音乐内容仍需试听核对'
                      : '媒体检查未完成',
                  }),
            });
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
    },

    /** 读一个产出文件（下载成果、读规划员写的方案用）；没有这个文件时 404 */
    async file(id: string, path: string): Promise<{ content: Buffer; contentType: string }> {
      const row = await owned(id);
      const found = row.outputs.find((f) => f.path === path && !isPrivateOutput(f.path));
      if (!found) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: await readLimited(
          archiveFile(await store.read(row.outputKey!), path),
          deps.inspectionLimits?.inputBytes ?? 100 * 1024 * 1024,
        ),
        contentType: contentTypeOf(path),
      };
    },

    async fileStream(id: string, path: string) {
      const row = await owned(id);
      const found = row.outputs.find((file) => file.path === path && !isPrivateOutput(path));
      if (!found || !row.outputKey) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: archiveFile(await store.read(row.outputKey), path),
        contentType: contentTypeOf(path),
        size: found.size,
        sha256: found.sha256,
      };
    },

    audioCheck: (id: string, payerId: string, taskId: string) =>
      checkedMedia(id, payerId, taskId, 'audio'),
    videoCheck: (id: string, payerId: string, taskId: string) =>
      checkedMedia(id, payerId, taskId, 'video'),
  };
}
