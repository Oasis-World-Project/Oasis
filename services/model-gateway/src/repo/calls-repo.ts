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

/** 某个型号的典型一次：花多少（微美元）、用多久（秒）、有几条记录 */
export interface Typical {
  costMicro: number;
  seconds: number;
  samples: number;
}

/** 从成功的调用记录算出的典型用量（ADR 0016 §4：估价不写死单价） */
export interface TypicalUsage {
  /** 工具：每个型号一次调用 */
  tools: Map<string, Typical>;
  /** 干活节点：每个型号一个节点（这个节点里该型号的所有聊天调用合计） */
  nodes: Map<string, Typical>;
  /** 所有节点的典型 token 用量，给没有记录的型号按价格表估；一条记录都没有时为 null */
  nodeTokens: { prompt: number; completion: number } | null;
}

export interface CallsRepo {
  start(call: NewCall): Promise<void>;
  get(id: string): Promise<Call | undefined>;
  /** 写结局；有事件时在同一个事务里写进发件箱 */
  finish(id: string, outcome: CallOutcome, event?: EventEnvelope): Promise<void>;
  /** 最近一次聊天、工具或决策调用因「地区不可用」失败的模型（之后没再成功过） */
  regionBlockedModels(): Promise<string[]>;
  typicalUsage(): Promise<TypicalUsage>;
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

    async typicalUsage() {
      const median = (expr: ReturnType<typeof sql>) =>
        sql`percentile_cont(0.5) within group (order by ${expr})`;
      type Row = { model: string; cost: number; seconds: number; samples: number };
      const toMap = (rows: Row[]) =>
        new Map(
          rows.map((r) => [
            r.model,
            {
              costMicro: Math.round(Number(r.cost)),
              seconds: Math.round(Number(r.seconds)),
              samples: Number(r.samples),
            },
          ]),
        );
      const tools = await db.execute<Row>(sql`
        select model, ${median(sql`charged_micro`)} as cost,
          ${median(sql`extract(epoch from finished_at - created_at)`)} as seconds, count(*) as samples
        from calls
        where kind = 'tool' and status = 'succeeded' and charged_micro is not null and finished_at is not null
        group by model
      `);
      const perNode = sql`
        select node_id, model, sum(coalesce(charged_micro, 0)) as cost,
          sum(coalesce(prompt_tokens, 0)) as prompt, sum(coalesce(completion_tokens, 0)) as completion,
          extract(epoch from max(finished_at) - min(created_at)) as seconds
        from calls
        where kind = 'chat' and node_id is not null and status = 'succeeded' and finished_at is not null
        group by node_id, model
      `;
      const nodes = await db.execute<Row>(sql`
        select model, ${median(sql`cost`)} as cost, ${median(sql`seconds`)} as seconds, count(*) as samples
        from (${perNode}) per_node group by model
      `);
      const [tokens] = (
        await db.execute<{ prompt: number | null; completion: number | null }>(sql`
          select ${median(sql`prompt`)} as prompt, ${median(sql`completion`)} as completion
          from (${perNode}) per_node
        `)
      ).rows;
      return {
        tools: toMap(tools.rows),
        nodes: toMap(nodes.rows),
        nodeTokens:
          tokens?.prompt == null || tokens.completion == null
            ? null
            : {
                prompt: Math.round(Number(tokens.prompt)),
                completion: Math.round(Number(tokens.completion)),
              },
      };
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
