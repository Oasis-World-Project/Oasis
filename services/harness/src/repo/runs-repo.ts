import type { EventEnvelope } from '@oasis/contracts/events';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { outbox, runEvents, runs } from './schema.ts';

export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
type NewRun = Pick<
  typeof runs.$inferInsert,
  'id' | 'payerId' | 'taskId' | 'nodeId' | 'model' | 'prompt'
>;
type RunPatch = Partial<Pick<Run, 'status' | 'error' | 'containerId' | 'runKeyId' | 'startedAt'>>;
export type RunOutcome = Pick<Run, 'status' | 'error' | 'outputs' | 'outputKey' | 'sessionKey'> & {
  finishedAt: Date;
};

const UNFINISHED = ['queued', 'starting', 'running'] as const;

export interface RunsRepo {
  /** 插入一条新运行；ID 已存在时不插入，返回 false（调用方自带 ID 时用于幂等） */
  insert(run: NewRun): Promise<boolean>;
  get(id: string): Promise<Run | undefined>;
  update(id: string, patch: RunPatch): Promise<void>;
  /** 写下结局，并在同一事务里把要发的事件写进发件箱 */
  finish(id: string, outcome: RunOutcome, event: EventEnvelope): Promise<void>;
  listUnfinished(): Promise<Run[]>;
  appendEvents(runId: string, events: Pick<RunEvent, 'seq' | 'kind' | 'data'>[]): Promise<void>;
  listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEvent[]>;
}

export function createRunsRepo(pool: pg.Pool): RunsRepo {
  const db = drizzle(pool);
  return {
    async insert(run) {
      const rows = await db
        .insert(runs)
        .values({ ...run, status: 'queued' })
        .onConflictDoNothing()
        .returning({ id: runs.id });
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
  };
}
