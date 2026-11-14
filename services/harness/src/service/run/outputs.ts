// 读运行的产出和过程：运行事件（对话里一轮的进度）、单个产出文件（画布登记成果时复制）。
import type { RunEventBody } from '@oasis/contracts/harness';
import { archiveFile, contentTypeOf, HttpError } from '@oasis/service-kit';
import { isPrivateOutput, type RunContext } from './shared.ts';

export function createOutputs(ctx: RunContext) {
  const { deps, owned } = ctx;
  const { repo, store } = deps;

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
  };
}
