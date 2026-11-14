import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { calls } from './schema.ts';

/** 上游拒绝「地区不可用」时返回的原文（记在调用记录的 error 里） */
export const REGION_ERROR = 'not available in your region';

export type CallKind = (typeof calls.$inferInsert)['kind'];
type NewCall = Pick<
  typeof calls.$inferInsert,
  'id' | 'kind' | 'payerId' | 'runId' | 'conversationId' | 'model' | 'tool' | 'requestId' | 'holdId'
>;
export type CallOutcome = Pick<
  typeof calls.$inferInsert,
  | 'status'
  | 'promptTokens'
  | 'completionTokens'
  | 'cachedTokens'
  | 'cacheWriteTokens'
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

/** 一个型号最近的实测：每秒输出、含缓存的实际单价、上游出错的比例 */
export interface Measured {
  calls: number;
  tokensPerSecond: number;
  /** 每百万 token 实际多少钱（输入输出合计，微美元） */
  microPerMTok: number;
  failureRate: number;
}

/** 调用少于这么多次的型号不给实测 */
const MIN_MEASURED_CALLS = 30;

/** 从成功的调用记录算出的典型用量（单价不写死） */
export interface TypicalUsage {
  /** 工具：每个型号一次调用 */
  tools: Map<string, Typical>;
}

export interface CallsRepo {
  start(call: NewCall): Promise<void>;
  get(id: string): Promise<Call | undefined>;
  /** 写结局（已经结算过的不再改） */
  finish(id: string, outcome: CallOutcome): Promise<void>;
  /** 对话里一轮已经结算的花费（模型、工具、沙箱算力合计，微美元）和用过的工具 */
  runSpend(runId: string, payerId: string): Promise<{ spentMicro: number; tools: string[] }>;
  /** 最近一次聊天、工具或决策调用因「地区不可用」失败的模型（之后没再成功过） */
  regionBlockedModels(): Promise<string[]>;
  typicalUsage(): Promise<TypicalUsage>;
  /** 各型号从 since 起的实测：只算 agent 运行里的聊天调用（私聊的用法不一样，不混在一起） */
  measured(since: Date): Promise<Map<string, Measured>>;
  /** 很久以前开始、一直没收尾的聊天和决策调用（网关中途重启时在途的请求） */
  staleRunning(before: Date, limit?: number): Promise<Call[]>;
  computeForRun(runId: string, payerId: string): Promise<Call[]>;
  /** 这个人从 since 起开始、还没做完的这些工具的调用，按工具数（同时在做几个） */
  runningTools(payerId: string, tools: string[], since: Date): Promise<Map<string, number>>;
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
    staleRunning: (before, limit = 100) =>
      db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.status, 'running'),
            inArray(calls.kind, ['chat', 'decision']),
            lt(calls.createdAt, before),
          ),
        )
        .limit(limit),
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
    async runningTools(payerId, tools, since) {
      const rows = await db
        .select({ tool: calls.tool, count: sql<string>`count(*)` })
        .from(calls)
        .where(
          and(
            eq(calls.payerId, payerId),
            eq(calls.status, 'running'),
            inArray(calls.tool, tools),
            gte(calls.createdAt, since),
          ),
        )
        .groupBy(calls.tool);
      return new Map(rows.map((row) => [row.tool ?? '', Number(row.count)]));
    },
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
      return { tools: toMap(tools.rows) };
    },

    async runSpend(runId, payerId) {
      const [row] = await db
        .select({
          spent: sql<string | null>`sum(${calls.chargedMicro})`,
          tools: sql<
            string[] | null
          >`array_agg(distinct ${calls.tool}) filter (where ${calls.tool} is not null)`,
        })
        .from(calls)
        .where(and(eq(calls.runId, runId), eq(calls.payerId, payerId)));
      return { spentMicro: Number(row?.spent ?? 0), tools: row?.tools ?? [] };
    },

    async measured(since) {
      const spoken = sql`status = 'succeeded' and completion_tokens > 0 and finished_at is not null`;
      const billed = sql`status = 'succeeded' and cost_source = 'provider'`;
      const { rows } = await db.execute<Record<string, string | null>>(sql`
        select model,
          count(*) filter (where status <> 'running') as calls,
          count(*) filter (where status = 'failed' and error like '上游%') as failed,
          sum(completion_tokens) filter (where ${spoken}) as completion,
          sum(extract(epoch from finished_at - created_at)) filter (where ${spoken}) as seconds,
          sum(upstream_cost_micro) filter (where ${billed}) as cost,
          sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0))
            filter (where ${billed}) as tokens
        from calls
        where kind = 'chat' and run_id is not null and created_at >= ${since}
        group by model
      `);
      return new Map(
        rows.flatMap((row) => {
          const calls = Number(row.calls);
          const seconds = Number(row.seconds);
          const tokens = Number(row.tokens);
          if (!row.model || calls < MIN_MEASURED_CALLS || !(seconds > 0) || !(tokens > 0))
            return [];
          const measured: Measured = {
            calls,
            tokensPerSecond: Math.round(Number(row.completion) / seconds),
            microPerMTok: Math.round((Number(row.cost) / tokens) * 1_000_000),
            failureRate: Number(row.failed) / calls,
          };
          return [[row.model, measured] as const];
        }),
      );
    },

    async finish(id, outcome) {
      await db
        .update(calls)
        .set({ ...outcome, finishedAt: new Date() })
        .where(and(eq(calls.id, id), isNull(calls.chargedMicro)));
    },
  };
}
