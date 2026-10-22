// 长任务的记录（ADR 0006 §4）。结算只能做一次：用「从 pending 改成结束」这一步来抢，抢到的才结算。
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { toolJobs } from './schema.ts';

export type ToolJob = typeof toolJobs.$inferSelect;

export interface ToolJobsRepo {
  insert(job: Pick<ToolJob, 'id' | 'tool' | 'providerJobId' | 'call'>): Promise<void>;
  get(id: string): Promise<ToolJob | undefined>;
  /** 把还在进行的长任务标成结束；已经被别人标过就返回 false */
  finish(id: string, status: 'completed' | 'failed', error?: string): Promise<boolean>;
}

export function createToolJobsRepo(pool: pg.Pool): ToolJobsRepo {
  const db = drizzle(pool);
  return {
    async insert(job) {
      await db.insert(toolJobs).values({ ...job, status: 'pending' });
    },
    async get(id) {
      const [row] = await db.select().from(toolJobs).where(eq(toolJobs.id, id));
      return row;
    },
    async finish(id, status, error) {
      const rows = await db
        .update(toolJobs)
        .set({ status, error: error ?? null, finishedAt: new Date() })
        .where(and(eq(toolJobs.id, id), eq(toolJobs.status, 'pending')))
        .returning({ id: toolJobs.id });
      return rows.length > 0;
    },
  };
}
