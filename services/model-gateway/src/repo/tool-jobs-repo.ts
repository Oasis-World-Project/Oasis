// 长任务的提交、文件持久化、结算与清理共用同一行；租约防止多个进程重复处理。
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { toolJobs } from './schema.ts';
export type ToolJob = typeof toolJobs.$inferSelect;
export interface ToolJobsRepo {
  insert(
    job: Pick<ToolJob, 'id' | 'tool' | 'providerJobId' | 'call' | 'requestKey' | 'requestHash'>,
  ): Promise<boolean>;
  byRequest(key: string): Promise<ToolJob | undefined>;
  get(id: string): Promise<ToolJob | undefined>;
  update(
    id: string,
    patch: Partial<
      Pick<ToolJob, 'providerJobId' | 'phase' | 'result' | 'cost' | 'expiresAt' | 'error'>
    >,
  ): Promise<void>;
  claim(id: string, token: string, until: Date): Promise<boolean>;
  unlock(id: string, token: string): Promise<void>;
  pending(limit: number): Promise<ToolJob[]>;
  expired(now: Date, limit: number): Promise<ToolJob[]>;
  finish(id: string, status: 'completed' | 'failed', error?: string): Promise<boolean>;
}
export function createToolJobsRepo(pool: pg.Pool): ToolJobsRepo {
  const db = drizzle(pool);
  return {
    async insert(job) {
      return (
        (
          await db
            .insert(toolJobs)
            .values({
              ...job,
              status: 'pending',
              phase: job.providerJobId ? 'pending' : 'submitting',
            })
            .onConflictDoNothing()
            .returning({ id: toolJobs.id })
        ).length > 0
      );
    },
    async byRequest(key) {
      const [row] = await db.select().from(toolJobs).where(eq(toolJobs.requestKey, key));
      return row;
    },
    async get(id) {
      const [row] = await db.select().from(toolJobs).where(eq(toolJobs.id, id));
      return row;
    },
    async update(id, patch) {
      await db.update(toolJobs).set(patch).where(eq(toolJobs.id, id));
    },
    async claim(id, token, until) {
      return (
        (
          await db
            .update(toolJobs)
            .set({ leaseToken: token, leaseUntil: until })
            .where(
              and(
                eq(toolJobs.id, id),
                or(
                  eq(toolJobs.leaseToken, token),
                  isNull(toolJobs.leaseUntil),
                  lt(toolJobs.leaseUntil, new Date()),
                ),
              ),
            )
            .returning({ id: toolJobs.id })
        ).length > 0
      );
    },
    async unlock(id, token) {
      await db
        .update(toolJobs)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(toolJobs.id, id), eq(toolJobs.leaseToken, token)));
    },
    pending: (limit) =>
      db
        .select()
        .from(toolJobs)
        .where(
          and(
            or(
              eq(toolJobs.status, 'pending'),
              and(eq(toolJobs.status, 'completed'), isNull(toolJobs.result)),
            ),
            or(
              eq(toolJobs.phase, 'pending'),
              eq(toolJobs.phase, 'stored'),
              and(
                eq(toolJobs.phase, 'submitting'),
                lt(toolJobs.createdAt, new Date(Date.now() - 120_000)),
              ),
            ),
          ),
        )
        .limit(limit),
    expired: (now, limit) =>
      db
        .select()
        .from(toolJobs)
        .where(and(lt(toolJobs.expiresAt, now), eq(toolJobs.phase, 'completed')))
        .limit(limit),
    async finish(id, status, error) {
      return (
        (
          await db
            .update(toolJobs)
            .set({ status, phase: status, error: error ?? null, finishedAt: new Date() })
            .where(eq(toolJobs.id, id))
            .returning({ id: toolJobs.id })
        ).length > 0
      );
    },
  };
}
