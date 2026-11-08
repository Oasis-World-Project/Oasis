// 沙箱和对象存储之间搬文件：运行结束把 out/ 打包存进对象存储（音视频顺带做受信检查），
// 开跑时把上游运行的产出、用户给的素材放进沙箱。会话和工作目录在持久卷里，不经对象存储。
import { PassThrough, Readable } from 'node:stream';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import { VideoCheckResult } from '@oasis/contracts/harness';
import { SANDBOX_PATHS } from '../../adapter/dsh.ts';
import type { Sandbox } from '../../executor/executor.ts';
import { rewriteArchive, scanArchive } from '../../executor/tar.ts';
import { audioPath, isPrivateOutput, StopRun, videoPath, type RunContext } from './shared.ts';

export function createStorage(
  ctx: RunContext,
): Pick<RunContext, 'save' | 'upstreamFiles' | 'materialFiles'> {
  const { deps } = ctx;
  const { repo, store, logger } = deps;

  /** 把沙箱里的目录打包存进对象存储；目录不存在或为空时返回 undefined */
  async function archive(sandbox: Pick<Sandbox, 'readArchive'>, path: string, key: string) {
    const stream = await sandbox.readArchive(path);
    if (!stream) return undefined;
    const upload = new PassThrough();
    const index = new PassThrough();
    const fail = (error: Error) => {
      stream.destroy(error);
      upload.destroy(error);
      index.destroy(error);
    };
    stream.on('error', fail);
    const storing = store.putStream(key, upload, 'application/x-tar', {
      maxBytes: deps.outputMaxBytes,
    });
    const scanning = scanArchive(index, deps.outputMaxBytes);
    stream.pipe(upload);
    stream.pipe(index);
    try {
      const [, files] = await Promise.all([storing, scanning]);
      if (!files.length) {
        await store.delete(key);
        return undefined;
      }
      return { key, files };
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled([storing, scanning]);
      await store.delete(key);
      throw error;
    }
  }

  return {
    async save(sandbox, id) {
      const outputs = await archive(sandbox, SANDBOX_PATHS.outputs, `runs/${id}/outputs.tar`);
      if (
        outputs &&
        sandbox.inspectMedia &&
        !ctx.state.live.get(id)?.abort.signal.aborted &&
        outputs.files.some((file) => audioPath.test(file.path) || videoPath.test(file.path))
      ) {
        try {
          const report = VideoCheckResult.parse(
            await sandbox.inspectMedia(await store.read(outputs.key)),
          );
          for (const [kind, pattern] of [
            ['audio', audioPath],
            ['video', videoPath],
          ] as const) {
            await store.put(
              `runs/${id}/${kind}-check.json`,
              Buffer.from(
                JSON.stringify({
                  files: report.files.filter((file) => pattern.test(file.path)),
                  unchecked: report.unchecked.filter((file) => pattern.test(file)),
                }),
              ),
              'application/json',
            );
          }
        } catch (err) {
          logger.warn({ err, runId: id }, '媒体检查未完成，关卡将保留未检查提醒');
        }
      }
      return { outputs };
    },

    async upstreamFiles(row) {
      const files: { dir: string; tar: Readable }[] = [];
      for (const ref of row.inputsFrom) {
        const upstream = await repo.get(ref.runId);
        if (!upstream?.outputKey) continue;
        files.push({
          dir: SANDBOX_PATHS.workdir,
          tar: rewriteArchive(
            await store.read(upstream.outputKey),
            `in/${ref.as}`,
            (path) => !isPrivateOutput(path),
            deps.outputMaxBytes,
          ),
        });
      }
      return files;
    },

    /** 路径已由 task 定好、契约校验过 */
    async materialFiles(materials, runId, ownerId) {
      if (!materials.length) return [];
      const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
        body: { ownerId, ids: materials.map((file) => file.uploadId) },
        schema: UploadLookupResult,
        requestId: runId,
      });
      const metadata = new Map(uploads.map((file) => [file.id, file]));
      let total = 0;
      return materials.map((m) => {
        const info = metadata.get(m.uploadId);
        if (!info) throw new Error('素材元数据缺失');
        total += info.size;
        if (deps.materialsMaxBytes !== undefined && total > deps.materialsMaxBytes)
          throw new StopRun('failed', '素材加起来超过运行上限');
        return {
          path: m.path,
          size: info.size,
          sha256: info.sha256,
          open: async () => {
            const response = await deps.canvas.stream(
              'GET',
              `/internal/uploads/${encodeURIComponent(m.uploadId)}/content`,
              {
                requestId: runId,
                signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000),
              },
            );
            if (!response.body) throw new Error('素材没有内容流');
            return Readable.fromWeb(response.body);
          },
        };
      });
    },
  };
}
