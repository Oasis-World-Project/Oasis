import type { EventEnvelope } from '@oasis/contracts/events';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { calls, outbox } from './schema.ts';

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
  /** 写结局；有事件时在同一个事务里写进发件箱 */
  finish(id: string, outcome: CallOutcome, event?: EventEnvelope): Promise<void>;
}

export function createCallsRepo(pool: pg.Pool): CallsRepo {
  const db = drizzle(pool);
  return {
    async start(call) {
      await db.insert(calls).values({ ...call, status: 'running' });
    },
    async finish(id, outcome, event) {
      await db.transaction(async (tx) => {
        await tx
          .update(calls)
          .set({ ...outcome, finishedAt: new Date() })
          .where(eq(calls.id, id));
        if (event) {
          await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
        }
      });
    },
  };
}
