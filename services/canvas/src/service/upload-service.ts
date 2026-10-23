// 素材：用户随消息发的文件。文件本身存对象存储，库里记是谁的、叫什么（ADR 0007 §3）。
import { randomUUID } from 'node:crypto';
import type { UploadBody } from '@oasis/contracts/canvas';
import { contentTypeOf, HttpError, type ObjectStore } from '@oasis/service-kit';
import type { Upload, UploadsRepo } from '../repo/uploads-repo.ts';

const toUploadBody = (row: Upload): UploadBody => ({
  id: row.id,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
  createdAt: row.createdAt.toISOString(),
});

const notFound = () => new HttpError(404, 'upload_not_found', '没有这个文件');

export function createUploadService(deps: { repo: UploadsRepo; store: ObjectStore }) {
  const { repo, store } = deps;

  async function content(row: Upload) {
    return { row, content: await store.get(row.objectKey) };
  }

  return {
    /** 存下一个文件；类型按文件名的扩展名定（浏览器报的类型不可信） */
    async upload(ownerId: string, name: string, body: Buffer): Promise<UploadBody> {
      const id = randomUUID();
      const objectKey = `uploads/${ownerId}/${id}`;
      const contentType = contentTypeOf(name);
      await store.put(objectKey, body, contentType);
      return toUploadBody(
        await repo.insert({ id, ownerId, name, size: body.length, contentType, objectKey }),
      );
    },

    /** 用户下载自己的文件 */
    async download(ownerId: string, id: string) {
      const row = await repo.find(id);
      if (row?.ownerId !== ownerId) throw notFound();
      return content(row);
    },

    /** 内部：查这些文件，必须都存在且都是这个人的 */
    async lookup(ownerId: string, ids: string[]): Promise<UploadBody[]> {
      const unique = [...new Set(ids)];
      const rows = await repo.findOwned(ownerId, unique);
      if (rows.length !== unique.length) throw notFound();
      const byId = new Map(rows.map((row) => [row.id, row]));
      return unique.map((id) => toUploadBody(byId.get(id)!));
    },

    /** 内部：取文件内容（harness 放进沙箱）；是不是付费人的文件，conversation 收附件时已核对 */
    async internalContent(id: string) {
      const row = await repo.find(id);
      if (!row) throw notFound();
      return content(row);
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;
