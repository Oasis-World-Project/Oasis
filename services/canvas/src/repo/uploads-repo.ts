import { and, eq, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { uploads } from './schema.ts';

export type Upload = typeof uploads.$inferSelect;

export interface UploadsRepo {
  insert(upload: Omit<Upload, 'createdAt'>): Promise<Upload>;
  find(id: string): Promise<Upload | undefined>;
  /** 这个人的这些文件（不是他的、不存在的不返回） */
  findOwned(ownerId: string, ids: string[]): Promise<Upload[]>;
  complete(id: string, info: { size: number; sha256: string }): Promise<Upload>;
  remove(id: string): Promise<void>;
  stale(before: Date): Promise<Upload[]>;
}

export function createUploadsRepo(pool: pg.Pool): UploadsRepo {
  const db = drizzle(pool);
  return {
    async insert(upload) {
      const [row] = await db.insert(uploads).values(upload).returning();
      return row!;
    },
    async find(id) {
      const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
      return row;
    },
    findOwned: (ownerId, ids) =>
      db
        .select()
        .from(uploads)
        .where(
          and(eq(uploads.ownerId, ownerId), eq(uploads.state, 'ready'), inArray(uploads.id, ids)),
        ),
    async complete(id, info) {
      const [row] = await db
        .update(uploads)
        .set({ ...info, state: 'ready' })
        .where(eq(uploads.id, id))
        .returning();
      return row!;
    },
    async remove(id) {
      await db.delete(uploads).where(eq(uploads.id, id));
    },
    stale: (before) =>
      db
        .select()
        .from(uploads)
        .where(and(eq(uploads.state, 'uploading'), lt(uploads.createdAt, before)))
        .limit(100),
  };
}
