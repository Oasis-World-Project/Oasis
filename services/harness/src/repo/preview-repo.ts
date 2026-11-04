import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { previewSessions } from './schema.ts';

export type PreviewRow = typeof previewSessions.$inferSelect;
type Patch = Partial<Omit<PreviewRow, 'id' | 'artifactId' | 'ownerId' | 'taskId' | 'createdAt'>>;
const ACTIVE = ['starting', 'running', 'stopping'] as const;

export interface PreviewRepo {
  insert(
    row: Pick<PreviewRow, 'id' | 'artifactId' | 'ownerId' | 'taskId' | 'deadlineAt'>,
  ): Promise<boolean>;
  latest(artifactId: string, ownerId: string): Promise<PreviewRow | undefined>;
  active(ownerId: string): Promise<PreviewRow | undefined>;
  update(id: string, patch: Patch): Promise<void>;
  unfinished(): Promise<PreviewRow[]>;
  /** 任务删除时真删除它已经结束的预览记录 */
  removeFinished(taskId: string): Promise<void>;
}

export function createPreviewRepo(pool: pg.Pool): PreviewRepo {
  const db = drizzle(pool);
  return {
    async insert(row) {
      const inserted = await db
        .insert(previewSessions)
        .values({ ...row, status: 'starting' })
        .onConflictDoNothing()
        .returning({ id: previewSessions.id });
      return inserted.length > 0;
    },
    async latest(artifactId, ownerId) {
      const [row] = await db
        .select()
        .from(previewSessions)
        .where(
          and(eq(previewSessions.artifactId, artifactId), eq(previewSessions.ownerId, ownerId)),
        )
        .orderBy(desc(previewSessions.createdAt))
        .limit(1);
      return row;
    },
    async active(ownerId) {
      const [row] = await db
        .select()
        .from(previewSessions)
        .where(
          and(eq(previewSessions.ownerId, ownerId), inArray(previewSessions.status, [...ACTIVE])),
        )
        .limit(1);
      return row;
    },
    update: async (id, patch) => {
      await db.update(previewSessions).set(patch).where(eq(previewSessions.id, id));
    },
    unfinished: () =>
      db
        .select()
        .from(previewSessions)
        .where(inArray(previewSessions.status, [...ACTIVE])),
    removeFinished: async (taskId) => {
      await db
        .delete(previewSessions)
        .where(
          and(eq(previewSessions.taskId, taskId), notInArray(previewSessions.status, [...ACTIVE])),
        );
    },
  };
}
