import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { uploads } from './schema.ts';

export type Upload = typeof uploads.$inferSelect;

export interface UploadsRepo {
  insert(upload: Omit<Upload, 'createdAt'>): Promise<Upload>;
  find(id: string): Promise<Upload | undefined>;
  /** 这个人的这些文件（不是他的、不存在的不返回） */
  findOwned(ownerId: string, ids: string[]): Promise<Upload[]>;
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
        .where(and(eq(uploads.ownerId, ownerId), inArray(uploads.id, ids))),
  };
}
