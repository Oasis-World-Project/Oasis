// 读运行的产出和过程：运行事件（对话里一轮的进度）、单个产出文件（画布登记成果时复制：一轮还在做时
// 做好一个就登记一个，从沙箱里读）、工作目录里的一个文件（进度页预览这一轮做出的中间产物）。
import type { RunEventBody } from '@oasis/contracts/harness';
import { archiveFile, contentTypeOf, HttpError, onlyFile } from '@oasis/service-kit';
import { SANDBOX_PATHS } from '../../adapter/dsh.ts';
import { isPrivateOutput, type RunContext } from './shared.ts';

/** 进度页预览的文件最大多少 */
const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
/** 一轮还在做时登记进画布的文件最大多少（和画布收的上限一样） */
const LIVE_MAX_BYTES = 512 * 1024 * 1024;

export function createOutputs(ctx: RunContext) {
  const { deps, owned } = ctx;
  const { repo, store } = deps;

  type Row = Awaited<ReturnType<typeof owned>>;

  /** 沙箱（或用户电脑）里的一个文件，相对 /workspace；读不到（不在了、电脑没连上）返回 undefined */
  async function liveFile(row: Row, path: string, maxBytes: number) {
    const live = await ctx
      .executorOf(row)
      .readStoredArchive?.(row.id, `${SANDBOX_PATHS.workdir}/${path}`)
      .catch(() => undefined);
    if (!live) return undefined;
    const file = await onlyFile(live, maxBytes).catch((err: unknown) => {
      throw new HttpError(422, 'file_unreadable', `读不了：${String(err)}`);
    });
    return { ...file, contentType: contentTypeOf(path) };
  }

  /**
   * out/ 里的一个文件（路径相对 out/）：这一轮收尾后从产出包读；还没收尾（做好一个就登记进画布）
   * 从沙箱里读，那时还没有摘要
   */
  async function fileStream(id: string, path: string) {
    const row = await owned(id);
    if (isPrivateOutput(path)) throw new HttpError(404, 'file_not_found', '没有这个文件');
    if (row.outputKey) {
      const found = row.outputs.find((file) => file.path === path);
      if (!found) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: archiveFile(await store.read(row.outputKey), path),
        contentType: contentTypeOf(path),
        size: found.size,
        sha256: found.sha256,
      };
    }
    const live = await liveFile(row, `out/${path}`, LIVE_MAX_BYTES);
    if (!live) throw new HttpError(404, 'file_not_found', '没有这个文件');
    return { ...live, sha256: undefined };
  }

  return {
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

    fileStream,

    /**
     * 这一轮工作目录里的一个文件（路径相对 /workspace）：沙箱还在就从沙箱里读；这一轮收尾、沙箱
     * 删掉以后从产出包读，那时只剩 out/ 下的。只给普通文件，链接、目录、太大的都不给。
     */
    async workspaceFile(id: string, path: string) {
      const row = await owned(id);
      if (path.split('/').some((part) => !part || part === '.' || part === '..'))
        throw new HttpError(400, 'invalid_path', '路径要相对工作目录');
      const live = await liveFile(row, path, PREVIEW_MAX_BYTES);
      if (live) return live;
      if (path.startsWith('out/') && row.outputKey)
        return fileStream(id, path.slice('out/'.length));
      throw new HttpError(404, 'file_not_found', '这一轮已经收尾，这个文件不在产出里');
    },
  };
}
