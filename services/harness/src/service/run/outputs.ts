// 读运行的产出和过程：运行事件、产出包的临时下载链接（给 inspector 检查，ADR 0024）、单个文件、
// 交付关卡的浏览器检查报告（task 交来留档，用户在工作流里下载）。
import type { ApplicationReportBody, OutputsLink, RunEventBody } from '@oasis/contracts/harness';
import { archiveFile, contentTypeOf, HttpError, readLimited } from '@oasis/service-kit';
import type { z } from 'zod';
import { isPrivateOutput, type RunContext } from './shared.ts';

/**
 * 产出包下载链接的有效期：一次关卡的文件解析、解码检查、浏览器检查共用一个链接，
 * inspector 的检查容器满了要排队，给 1 小时
 */
const LINK_SECONDS = 60 * 60;
/** 读进内存的单个产出文件上限（下载成果、读规划员写的方案） */
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const reportKey = (id: string) => `runs/${id}/application-check.json`;

export function createOutputs(ctx: RunContext) {
  const { deps, owned } = ctx;
  const { repo, store } = deps;

  /** 这次运行，且是这个付费人、这个任务的；不是就当没有 */
  async function mine(id: string, payerId: string, taskId: string) {
    const row = await owned(id);
    if (row.payerId !== payerId || row.taskId !== taskId)
      throw new HttpError(404, 'run_not_found', '没有这次运行');
    return row;
  }

  return {
    /** 交付关卡的浏览器检查报告留档（inspector 检查完由 task 交来，ADR 0024）；再查一次就覆盖 */
    async saveApplicationReport(id: string, body: z.infer<typeof ApplicationReportBody>) {
      await mine(id, body.payerId, body.taskId);
      await store.put(reportKey(id), Buffer.from(JSON.stringify(body.report)), 'application/json');
    },

    /** 读浏览器检查报告（用户在工作流里下载）；还没有时 404 */
    async applicationReport(id: string, payerId: string, taskId: string): Promise<Buffer> {
      await mine(id, payerId, taskId);
      try {
        return await store.get(reportKey(id));
      } catch {
        throw new HttpError(404, 'check_not_found', '这次运行还没有浏览器检查报告');
      }
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

    /** 产出包的临时下载链接（交给 inspector 检查，ADR 0024）：只给这次运行的付费人和任务 */
    async outputsLink(id: string, payerId: string, taskId: string): Promise<OutputsLink> {
      const row = await owned(id);
      if (row.payerId !== payerId || row.taskId !== taskId || !row.outputKey)
        throw new HttpError(404, 'outputs_not_found', '这次运行没有产出');
      if (!store.sign) throw new HttpError(503, 'link_unavailable', '对象存储不支持临时下载链接');
      return {
        url: await store.sign(row.outputKey, 'GET', LINK_SECONDS),
        expiresAt: new Date(Date.now() + LINK_SECONDS * 1000).toISOString(),
      };
    },

    /** 读一个产出文件（下载成果、读规划员写的方案用）；没有这个文件时 404 */
    async file(id: string, path: string): Promise<{ content: Buffer; contentType: string }> {
      const row = await owned(id);
      const found = row.outputs.find((f) => f.path === path && !isPrivateOutput(f.path));
      if (!found) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: await readLimited(
          archiveFile(await store.read(row.outputKey!), path),
          FILE_MAX_BYTES,
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
  };
}
