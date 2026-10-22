import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { calls } from './schema.ts';

export type CallKind = (typeof calls.$inferInsert)['kind'];
type NewCall = Pick<
  typeof calls.$inferInsert,
  'id' | 'kind' | 'payerId' | 'runId' | 'taskId' | 'nodeId' | 'model' | 'requestId' | 'holdId'
>;
export type CallOutcome = Pick<
  typeof calls.$inferInsert,
  | 'status'
  | 'promptTokens'
  | 'completionTokens'
  | 'upstreamCostMicro'
  | 'chargedMicro'
  | 'costSource'
  | 'error'
>;

export interface CallsRepo {
  start(call: NewCall): Promise<void>;
  finish(id: string, outcome: CallOutcome): Promise<void>;
}

export function createCallsRepo(pool: pg.Pool): CallsRepo {
  const db = drizzle(pool);
  return {
    async start(call) {
      await db.insert(calls).values({ ...call, status: 'running' });
    },
    async finish(id, outcome) {
      await db
        .update(calls)
        .set({ ...outcome, finishedAt: new Date() })
        .where(eq(calls.id, id));
    },
  };
}
