// 素材：用户随消息发的文件。文件本身存对象存储，库里记是谁的、叫什么（ADR 0007 §3）。
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { UploadBody } from '@oasis/contracts/canvas';
import {
  contentTypeOf,
  HttpError,
  type ObjectStore,
  type StreamLimits,
  type Logger,
} from '@oasis/service-kit';
import type { Upload, UploadsRepo } from '../repo/uploads-repo.ts';

const toUploadBody = (row: Upload): UploadBody => ({
  id: row.id,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
  sha256: row.sha256,
  createdAt: row.createdAt.toISOString(),
});

const notFound = () => new HttpError(404, 'upload_not_found', '没有这个文件');

export function createUploadService(deps: {
  repo: UploadsRepo;
  store: ObjectStore;
  logger?: Logger;
}) {
  const { repo, store } = deps;

  let timer: ReturnType<typeof setInterval> | undefined;
  /** 删掉一个上传：对象和记录一起删 */
  const purge = async (row: Upload) => {
    await store.delete(row.objectKey);
    await repo.remove(row.id);
  };
  // 清扫（每小时）：没传完的、传完 24 小时一直没被消息或批注用上的，都彻底删掉（2026-11-05 真删除）
  const cleanup = async () => {
    const before = new Date(Date.now() - 24 * 3600_000);
    for (const row of [...(await repo.stale(before)), ...(await repo.unclaimed(before))])
      await purge(row);
  };
  return {
    start() {
      if (!timer) {
        const recover = () => {
          void cleanup().catch((err: unknown) =>
            deps.logger?.warn({ err }, '未完成上传清理失败，将重试'),
          );
        };
        timer = setInterval(recover, 3600_000);
        timer.unref();
        recover();
      }
    },
    close() {
      if (timer) clearInterval(timer);
    },
    /** 存下一个文件；类型按文件名的扩展名定（浏览器报的类型不可信） */
    async upload(
      ownerId: string,
      name: string,
      body: Buffer | Readable,
      limits: StreamLimits = { maxBytes: 100 * 1024 * 1024 },
    ): Promise<UploadBody> {
      const id = randomUUID();
      const objectKey = `uploads/${ownerId}/${id}`;
      const contentType = contentTypeOf(name);
      const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
      try {
        await repo.insert({
          id,
          ownerId,
          name,
          size: 0,
          sha256: null,
          state: 'uploading',
          contentType,
          objectKey,
        });
        const saved = await store.putStream(objectKey, source, contentType, limits);
        return toUploadBody(await repo.complete(id, saved));
      } catch (error) {
        source.destroy();
        await store.delete(objectKey);
        await repo.remove(id);
        throw error;
      }
    },

    /** 用户自己的文件（下载由接口层边读边传） */
    async owned(ownerId: string, id: string): Promise<Upload> {
      const row = await repo.find(id);
      if (row?.ownerId !== ownerId || row.state !== 'ready') throw notFound();
      return row;
    },

    /**
     * 内部：查这些文件，必须都存在且都是这个人的。
     * partial：只返回还在的（再改新版时筛掉已随上一版删除的修订素材，ADR 0012）
     */
    async lookup(
      ownerId: string,
      ids: string[],
      partial = false,
      claim = false,
    ): Promise<UploadBody[]> {
      const unique = [...new Set(ids)];
      const rows = await repo.findOwned(ownerId, unique);
      if (!partial && rows.length !== unique.length) throw notFound();
      // 随消息发出：文件被用上了，清扫不再删它
      if (claim)
        await repo.claim(
          ownerId,
          rows.map((row) => row.id),
        );
      const byId = new Map(rows.map((row) => [row.id, row]));
      return unique.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toUploadBody(row)] : [];
      });
    },

    /**
     * 内部：彻底删除这个人的这些文件（消息被删、群被解散时 conversation 调用，2026-11-05 真删除）。
     * 不是他的、已经删过的跳过；幂等。
     */
    async remove(ownerId: string, ids: string[]): Promise<number> {
      const rows = await repo.findOwned(ownerId, [...new Set(ids)]);
      for (const row of rows) await purge(row);
      return rows.length;
    },

    /** 内部：取文件内容（harness 放进沙箱）；是不是付费人的文件，conversation 收附件时已核对 */
    async internalContent(id: string) {
      const row = await repo.find(id);
      if (!row || row.state !== 'ready') throw notFound();
      return { row, content: await store.read(row.objectKey) };
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;
