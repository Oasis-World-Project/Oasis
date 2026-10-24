import type { ArtifactCategory } from '@oasis/contracts/canvas';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { artifacts } from './schema.ts';

export type Artifact = typeof artifacts.$inferSelect;
type NewArtifact = Omit<Artifact, 'createdAt'>;

export interface ArtifactsRepo {
  /** 已经登记过（同一个任务、节点、路径）就什么也不做，返回 false */
  insert(artifact: NewArtifact): Promise<boolean>;
  find(id: string): Promise<Artifact | undefined>;
  list(
    ownerId: string,
    filter: { category?: ArtifactCategory; taskId?: string },
    limit: number,
  ): Promise<Artifact[]>;
  listByTask(taskId: string): Promise<Artifact[]>;
  /** 这个用户在电脑上已经用掉的任务文件夹名（sync_path 的第一段），不含这个任务的 */
  syncDirs(ownerId: string, exceptTaskId: string): Promise<string[]>;
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
  };
}
