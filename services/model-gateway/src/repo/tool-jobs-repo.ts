// 长任务的提交、文件持久化、结算与清理共用同一行；租约防止多个进程重复处理。
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { toolJobs, toolRunControls } from './schema.ts';
export type ToolJob = typeof toolJobs.$inferSelect;
export class ToolAdmissionError extends Error {}
export interface ToolJobsRepo {
  cancelRun(runId: string, payerId: string, taskId?: string): Promise<void>;
  mergeCall(id: string, patch: Record<string, unknown>): Promise<void>;
  renderWindowEnd(exceptId: string): Promise<number>;
  insert(
    job: Pick<ToolJob, 'id' | 'tool' | 'providerJobId' | 'call' | 'requestKey' | 'requestHash'>,
  ): Promise<boolean>;
  byRequest(key: string): Promise<ToolJob | undefined>;
  requestCancel(id: string): Promise<void>;
  forRun(runId: string): Promise<ToolJob[]>;
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
    async renderWindowEnd(exceptId) {
      const result = await db.execute<{ boundary: string | null }>(sql`
        select max(coalesce(
          (call->'autoAudit'->>'windowEnd')::bigint,
          (floor(extract(epoch from coalesce(finished_at, created_at)) / 3600) + 1)::bigint * 3600000
        ))::text as boundary from tool_jobs where tool = '3d.render' and id <> ${exceptId}::uuid
      `);
      return Number(result.rows[0]?.boundary ?? 0);
    },
    async insert(job) {
      return db.transaction(async (tx) => {
        if (job.tool === '3d.render') {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('oasis-render-admission',0))`,
          );
          const [active] = await tx
            .select()
            .from(toolJobs)
            .where(and(eq(toolJobs.tool, '3d.render'), eq(toolJobs.status, 'pending')))
            .limit(1);
          if (active) {
            if (job.requestKey && active.requestKey === job.requestKey) return false;
            throw new ToolAdmissionError('GPU profile busy or awaiting cost reconciliation');
          }
        }
        const caller = job.call.caller as { runId?: string; payerId: string; taskId?: string };
        if (caller.runId) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${caller.runId},0))`);
          await tx
            .insert(toolRunControls)
            .values({ runId: caller.runId, payerId: caller.payerId, taskId: caller.taskId ?? null })
            .onConflictDoNothing();
          const [control] = await tx
            .select()
            .from(toolRunControls)
            .where(eq(toolRunControls.runId, caller.runId));
          if (control?.cancelledAt) throw new Error('Run cancellation fences new tool admission');
          if (
            control?.payerId !== caller.payerId ||
            (control.taskId && control.taskId !== caller.taskId)
          )
            throw new Error('Run owner mismatch');
        }
        return (
          (
            await tx
              .insert(toolJobs)
              .values({
                ...job,
                status: 'pending',
                phase:
                  job.tool === '3d.render'
                    ? 'uploading'
                    : job.providerJobId
                      ? 'pending'
                      : 'submitting',
              })
              .onConflictDoNothing()
              .returning({ id: toolJobs.id })
          ).length > 0
        );
      });
    },
    async cancelRun(runId, payerId, taskId) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId},0))`);
        await tx
          .insert(toolRunControls)
          .values({ runId, payerId, taskId: taskId ?? null, cancelledAt: new Date() })
          .onConflictDoNothing();
        const [control] = await tx
          .select()
          .from(toolRunControls)
          .where(eq(toolRunControls.runId, runId));
        if (control?.payerId !== payerId || (control.taskId && control.taskId !== taskId))
          throw new Error('Run owner mismatch');
        await tx
          .update(toolRunControls)
          .set({ cancelledAt: new Date() })
          .where(eq(toolRunControls.runId, runId));
        await tx
          .update(toolJobs)
          .set({
            call: sql`${toolJobs.call} || '{"cancelRequested":true}'::jsonb`,
            phase: 'cancel_requested',
          })
          .where(
            and(
              eq(toolJobs.status, 'pending'),
              sql`${toolJobs.call}->'caller'->>'runId' = ${runId}`,
            ),
          );
      });
    },
    async mergeCall(id, patch) {
      await db
        .update(toolJobs)
        .set({ call: sql`${toolJobs.call} || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(toolJobs.id, id));
    },
    async byRequest(key) {
      const [row] = await db.select().from(toolJobs).where(eq(toolJobs.requestKey, key));
      return row;
    },
    async requestCancel(id) {
      await db
        .update(toolJobs)
        .set({
          call: sql`${toolJobs.call} || '{"cancelRequested":true}'::jsonb`,
          phase: 'cancel_requested',
        })
        .where(and(eq(toolJobs.id, id), eq(toolJobs.status, 'pending')));
    },
    forRun: (runId) =>
      db
        .select()
        .from(toolJobs)
        .where(
          and(eq(toolJobs.status, 'pending'), sql`${toolJobs.call}->'caller'->>'runId' = ${runId}`),
        ),
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
            sql`coalesce((${toolJobs.call}->>'nextCheckAt')::bigint,0) <= ${Date.now()}`,
            or(
              eq(toolJobs.status, 'pending'),
              and(eq(toolJobs.status, 'completed'), isNull(toolJobs.result)),
              and(
                eq(toolJobs.tool, '3d.render'),
                sql`(${toolJobs.call}->'autoAudit'->>'watchUntil')::bigint > ${Date.now()}`,
              ),
            ),
            or(
              eq(toolJobs.phase, 'pending'),
              eq(toolJobs.phase, 'stored'),
              eq(toolJobs.phase, 'cancel_requested'),
              eq(toolJobs.phase, 'uploading'),
              eq(toolJobs.phase, 'awaiting_cost'),
              and(eq(toolJobs.phase, 'uncertain'), eq(toolJobs.tool, '3d.render')),
              and(
                eq(toolJobs.tool, '3d.render'),
                sql`(${toolJobs.call}->'autoAudit'->>'watchUntil')::bigint > ${Date.now()}`,
              ),
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
