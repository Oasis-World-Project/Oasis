import type { EventEnvelope } from '@oasis/contracts/events';
import type { StartRunBody } from '@oasis/contracts/harness';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { outbox, runEvents, runs } from './schema.ts';

export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export interface DurableRunRequest {
  body: StartRunBody & Required<Pick<StartRunBody, 'inputs' | 'inputsFrom'>>;
  persistent: boolean;
}
type NewRun = Pick<
  typeof runs.$inferInsert,
  | 'id'
  | 'payerId'
  | 'taskId'
  | 'nodeId'
  | 'model'
  | 'prompt'
  | 'inputsFrom'
  | 'sessionId'
  | 'continueFrom'
>;
type RunPatch = Partial<
  Pick<
    Run,
    | 'status'
    | 'error'
    | 'containerId'
    | 'runKeyId'
    | 'startedAt'
    | 'outputs'
    | 'outputKey'
    | 'sessionKey'
    | 'summary'
  >
>;
export type RunOutcome = Pick<
  Run,
  'status' | 'error' | 'outputs' | 'outputKey' | 'sessionKey' | 'summary'
> & {
  finishedAt: Date;
};

const UNFINISHED = ['queued', 'starting', 'running'] as const;

export interface RunsRepo {
  /** 插入一条新运行；ID 已存在时不插入，返回 false（调用方自带 ID 时用于幂等） */
  insert(run: NewRun, request?: DurableRunRequest): Promise<boolean>;
  request(runId: string): Promise<unknown>;
  control(runId: string): Promise<'stop' | 'cancel' | undefined>;
  hasRootPrompt(runId: string): Promise<boolean>;
  get(id: string): Promise<Run | undefined>;
  update(id: string, patch: RunPatch): Promise<void>;
  /** 写下结局，并在同一事务里把要发的事件写进发件箱 */
  finish(id: string, outcome: RunOutcome, event: EventEnvelope): Promise<void>;
  listUnfinished(): Promise<Run[]>;
  appendEvents(runId: string, events: Pick<RunEvent, 'seq' | 'kind' | 'data'>[]): Promise<void>;
  listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEvent[]>;
  nextSequence(runId: string): Promise<number>;
  /** 属于这个任务的全部运行（任务被删除时清理，ADR 0012） */
  listByTask(taskId: string): Promise<Run[]>;
  listBySession(sessionId: string): Promise<Run[]>;
  /** 删掉这些运行（运行事件级联删除） */
  removeMany(ids: string[]): Promise<void>;
}

export function createRunsRepo(pool: pg.Pool): RunsRepo {
  const db = drizzle(pool);
  return {
    async insert(run, request) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(runs)
          .values({ ...run, status: 'queued' })
          .onConflictDoNothing()
          .returning({ id: runs.id });
        if (rows.length && request)
          await tx.insert(runEvents).values({
            runId: run.id,
            seq: 0,
            kind: 'status',
            data: { status: 'admitted', request },
          });
        return rows.length > 0;
      });
    },
    async request(runId) {
      const [event] = await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.seq, 0)));
      return event?.data.request;
    },
    async control(runId) {
      const [event] = await db
        .select()
        .from(runEvents)
        .where(
          and(eq(runEvents.runId, runId), sql`${runEvents.data}->>'status' = 'control_requested'`),
        )
        .orderBy(desc(runEvents.seq))
        .limit(1);
      return event?.data.how === 'stop'
        ? 'stop'
        : event?.data.how === 'cancel'
          ? 'cancel'
          : undefined;
    },
    async hasRootPrompt(runId) {
      const rows = await db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(
          and(
            eq(runEvents.runId, runId),
            eq(runEvents.kind, 'user_message'),
            sql`${runEvents.data}->>'parentSessionId' is null`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
    async get(id) {
      const [row] = await db.select().from(runs).where(eq(runs.id, id));
      return row;
    },
    async update(id, patch) {
      await db.update(runs).set(patch).where(eq(runs.id, id));
    },
    async finish(id, outcome, event) {
      await db.transaction(async (tx) => {
        await tx.update(runs).set(outcome).where(eq(runs.id, id));
        await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
      });
    },
    listUnfinished: () =>
      db
        .select()
        .from(runs)
        .where(inArray(runs.status, [...UNFINISHED])),
    async appendEvents(runId, events) {
      if (events.length === 0) return;
      await db
        .insert(runEvents)
        .values(events.map((e) => ({ ...e, runId })))
        .onConflictDoNothing();
    },
    listEvents: (runId, afterSeq, limit) =>
      db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
        .orderBy(asc(runEvents.seq))
        .limit(limit),
    async nextSequence(runId) {
      const [row] = await db
        .select({ next: sql<number>`coalesce(max(${runEvents.seq}), -1) + 1` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      return Number(row?.next ?? 0);
    },
    listByTask: (taskId) => db.select().from(runs).where(eq(runs.taskId, taskId)),
    listBySession: (sessionId) => db.select().from(runs).where(eq(runs.sessionId, sessionId)),
    async removeMany(ids) {
      if (ids.length) await db.delete(runs).where(inArray(runs.id, ids));
    },
  };
}
