import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { models } from './schema.ts';

export type ModelRow = typeof models.$inferSelect;

export function createModelRepo(pool: pg.Pool) {
  const db = drizzle(pool);
  return {
    list: (): Promise<ModelRow[]> => db.select().from(models).orderBy(asc(models.sortOrder)),
    async find(key: string): Promise<ModelRow | undefined> {
      const [row] = await db.select().from(models).where(eq(models.key, key));
      return row;
    },
  };
}

export type ModelRepo = ReturnType<typeof createModelRepo>;
