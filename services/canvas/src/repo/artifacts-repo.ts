import type { ArtifactCategory } from '@oasis/contracts/canvas';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { artifacts, uploads } from './schema.ts';

export type Artifact = typeof artifacts.$inferSelect;
/** 新登记的成果没有批注、没有批准（表里有默认值） */
export type NewArtifact = Omit<Artifact, 'createdAt' | 'annotations' | 'approvedAt'>;

export interface ArtifactsRepo {
  /** 已经登记过（同一个任务、节点、路径）就什么也不做，返回 false */
  insert(artifact: NewArtifact): Promise<boolean>;
  find(id: string): Promise<Artifact | undefined>;
  setApplication(id: string, spec: Artifact['appSpec']): Promise<void>;
  list(
    ownerId: string,
    filter: { category?: ArtifactCategory; taskId?: string },
    limit: number,
  ): Promise<Artifact[]>;
  listByTask(taskId: string): Promise<Artifact[]>;
  /** 这个用户在电脑上已经用掉的任务文件夹名（sync_path 的第一段），不含这个任务的 */
  syncDirs(ownerId: string, exceptTaskId: string): Promise<string[]>;
  /**
   * 新版替换旧版（ADR 0012）：一个事务里删掉旧任务的成果行和来自它的修订素材行，再插入新版的行
   * （已经登记过的跳过）。
   */
  replaceTask(oldTaskId: string, rows: NewArtifact[]): Promise<void>;
  /** 删掉这些成果行和修订素材行（对象已经删掉） */
  removeRows(artifactIds: string[], uploadIds: string[]): Promise<void>;
  /** 批注整份替换、批准记号（ADR 0012 §9） */
  setReview(
    id: string,
    patch: Partial<Pick<Artifact, 'annotations' | 'approvedAt'>>,
  ): Promise<Artifact | undefined>;
}

export function createArtifactsRepo(pool: pg.Pool): ArtifactsRepo {
  const db = drizzle(pool);
  return {
    async insert(artifact) {
      const rows = await db
        .insert(artifacts)
        .values(artifact)
        .onConflictDoNothing({
          target: [artifacts.taskId, artifacts.nodeId, artifacts.path],
        })
        .returning({ id: artifacts.id });
      return rows.length > 0;
    },
    async find(id) {
      const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
      return row;
    },
    async setApplication(id, spec) {
      await db
        .update(artifacts)
        .set({ appSpec: spec, category: 'app' })
        .where(eq(artifacts.id, id));
    },
    list: (ownerId, filter, limit) =>
      db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.ownerId, ownerId),
            filter.category ? eq(artifacts.category, filter.category) : undefined,
            filter.taskId ? eq(artifacts.taskId, filter.taskId) : undefined,
          ),
        )
        .orderBy(desc(artifacts.createdAt), artifacts.path)
        .limit(limit),
    listByTask: (taskId) => db.select().from(artifacts).where(eq(artifacts.taskId, taskId)),
    async syncDirs(ownerId, exceptTaskId) {
      const rows = await db
        .selectDistinct({ dir: sql<string>`split_part(${artifacts.syncPath}, '/', 1)` })
        .from(artifacts)
        .where(and(eq(artifacts.ownerId, ownerId), sql`${artifacts.taskId} <> ${exceptTaskId}`));
      return rows.map((r) => r.dir);
    },
    async replaceTask(oldTaskId, rows) {
      await db.transaction(async (tx) => {
        await tx.delete(artifacts).where(eq(artifacts.taskId, oldTaskId));
        await tx.delete(uploads).where(eq(uploads.sourceTaskId, oldTaskId));
        if (rows.length > 0)
          await tx
            .insert(artifacts)
            .values(rows)
            .onConflictDoNothing({ target: [artifacts.taskId, artifacts.nodeId, artifacts.path] });
      });
    },
    async removeRows(artifactIds, uploadIds) {
      await db.transaction(async (tx) => {
        if (artifactIds.length)
          await tx.delete(artifacts).where(inArray(artifacts.id, artifactIds));
        if (uploadIds.length) await tx.delete(uploads).where(inArray(uploads.id, uploadIds));
      });
    },
    async setReview(id, patch) {
      const [row] = await db.update(artifacts).set(patch).where(eq(artifacts.id, id)).returning();
      return row;
    },
  };
}
