import type { EventEnvelope } from '@oasis/contracts/events';
import { and, eq, isNull, sql } from 'drizzle-orm';
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

export type Call = typeof calls.$inferSelect;

export interface CallsRepo {
  start(call: NewCall): Promise<void>;
  get(id: string): Promise<Call | undefined>;
  /** 写结局；有事件时在同一个事务里写进发件箱 */
  finish(id: string, outcome: CallOutcome, event?: EventEnvelope): Promise<void>;
  /** 最近一次聊天、工具或决策调用因「地区不可用」失败的模型（之后没再成功过） */
  regionBlockedModels(): Promise<string[]>;
  computeForRun(runId: string, payerId: string): Promise<Call[]>;
}

export function createCallsRepo(pool: pg.Pool): CallsRepo {
  const db = drizzle(pool);
  return {
    async start(call) {
      await db.insert(calls).values({ ...call, status: 'running' });
    },
    async get(id) {
      const [row] = await db.select().from(calls).where(eq(calls.id, id));
      return row;
    },
    computeForRun: (runId, payerId) =>
      db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.runId, runId),
            eq(calls.payerId, payerId),
            eq(calls.kind, 'compute'),
            eq(calls.model, 'sandbox'),
          ),
        ),
    async regionBlockedModels() {
      const result = await db.execute<{ model: string }>(sql`
        select model from (
          select distinct on (model) model, status, error from calls
          where kind in ('chat', 'tool', 'decision') and finished_at is not null
          order by model, finished_at desc
        ) latest
        where status = 'failed' and error ilike ${`%${REGION_ERROR}%`}
      `);
      return result.rows.map((r) => r.model);
    },

    async finish(id, outcome, event) {
      await db.transaction(async (tx) => {
        const changed = await tx
          .update(calls)
          .set({ ...outcome, finishedAt: new Date() })
          .where(and(eq(calls.id, id), isNull(calls.chargedMicro)))
          .returning({ id: calls.id });
        if (event && changed.length > 0) {
          await tx.insert(outbox).values({ id: event.id, subject: event.type, payload: event });
        }
      });
    },
  };
}
