// 读运行的产出和过程：运行事件（对话里一轮的进度）、单个产出文件（画布登记成果时复制）、工作目录里的
// 一个文件（进度页预览这一轮做出的中间产物）。文件都从这个会话的工作目录里现读，平台不另存一份。
import type { RunEventBody } from '@oasis/contracts/harness';
import { contentTypeOf, HttpError, onlyFile } from '@oasis/service-kit';
import { SANDBOX_PATHS } from '../../adapter/dsh.ts';
import { isPrivateOutput, type RunContext } from './shared.ts';

/** 进度页预览的文件最大多少 */
const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
/** 登记进画布的文件最大多少（和画布收的上限一样） */
const FILE_MAX_BYTES = 512 * 1024 * 1024;

export function createOutputs(ctx: RunContext) {
  const { deps, owned } = ctx;
  const { repo } = deps;

  type Row = Awaited<ReturnType<typeof owned>>;

  /** 这一轮工作目录里的一个文件，相对 /workspace；读不到（不在了、电脑没连上）返回 undefined */
  async function workFile(row: Row, path: string, maxBytes: number) {
    const live = await ctx
      .executorOf(row)
      .readWorkspace(row.sessionId ?? row.id, `${SANDBOX_PATHS.workdir}/${path}`)
      .catch(() => undefined);
    if (!live) return undefined;
    const file = await onlyFile(live, maxBytes).catch((err: unknown) => {
      throw new HttpError(422, 'file_unreadable', `读不了：${String(err)}`);
    });
    return { ...file, contentType: contentTypeOf(path) };
  }

  /**
   * out/ 里的一个文件（路径相对 out/），从工作目录里现读：一轮还在做时做好一个画布就登记一个；收尾后
   * 画布按这一轮的清单来取内容变了的
   */
  async function fileStream(id: string, path: string) {
    const row = await owned(id);
    const finished = !['queued', 'starting', 'running'].includes(row.status);
    if (isPrivateOutput(path) || (finished && !row.outputs.some((file) => file.path === path)))
      throw new HttpError(404, 'file_not_found', '没有这个文件');
    const file = await workFile(row, `out/${path}`, FILE_MAX_BYTES);
    if (!file) throw new HttpError(404, 'file_not_found', '没有这个文件');
    return file;
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

    /** 这一轮工作目录里的一个文件（路径相对 /workspace）。只给普通文件，链接、目录、太大的都不给。 */
    async workspaceFile(id: string, path: string) {
      const row = await owned(id);
      if (path.split('/').some((part) => !part || part === '.' || part === '..'))
        throw new HttpError(400, 'invalid_path', '路径要相对工作目录');
      const file = await workFile(row, path, PREVIEW_MAX_BYTES);
      if (!file) throw new HttpError(404, 'file_not_found', '这个文件不在工作目录里了');
      return file;
    },
  };
}
