import type { EventEnvelope } from '@oasis/contracts/events';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { calls, outbox } from './schema.ts';

/** 上游拒绝「地区不可用」时返回的原文（记在调用记录的 error 里） */
export const REGION_ERROR = 'not available in your region';

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
  /** 最近一次聊天调用因为「地区不可用」失败的模型（之后没再成功过） */
  regionBlockedModels(): Promise<string[]>;
}

export function createCallsRepo(pool: pg.Pool): CallsRepo {
  const db = drizzle(pool);
  return {
    async start(call) {
      await db.insert(calls).values({ ...call, status: 'running' });
    },
    async regionBlockedModels() {
      const result = await db.execute<{ model: string }>(sql`
        select model from (
          select distinct on (model) model, status, error from calls
          where kind = 'chat' and finished_at is not null
          order by model, finished_at desc
        ) latest
        where status = 'failed' and error ilike ${`%${REGION_ERROR}%`}
      `);
      return result.rows.map((r) => r.model);
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
