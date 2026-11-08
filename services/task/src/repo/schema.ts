// 与 migrations/ 里的表一一对应（表结构以 SQL 迁移为准）。
import type { RunInputFile, RunOutputFile } from '@oasis/contracts/harness';
import type { Material } from '@oasis/contracts/canvas';
import type {
  Attention,
  ExpectedFile,
  ForeachBranch,
  NodeBody,
  NodeStatus,
  PlanNode,
  RevisionChange,
  TaskSheet,
  TaskStatus,
  TaskCheck,
  Variants,
} from '@oasis/contracts/task';
import type { ToolStep } from '@oasis/contracts/tool-step';
import { bigint, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 每种节点都有的配置（引擎、关卡、修改流程用）：自查清单、应有文件、交付文件，以及推进中记下的状态。
 * 各种节点自己的配置在下面，按种类定型（重构阶段 2）：引擎碰不到某种节点特有的字段。
 */
interface CommonConfig {
  requires?: string[];
  /** 最终验收退回后，等待上游最新产出再在原会话修复。 */
  repairChecks?: string[];
  /** 用户看过成果后的修改意见（ADR 0012）：开跑时接着原会话按意见改（ADR 0022 起只用于「接着原会话改」的节点） */
  revision?: string;
  /** 修改时「重新做」的节点：上一版它交出产出的那次运行，产出放进 in/_previous/（ADR 0022） */
  previousRunId?: string;
  checks?: TaskCheck[];
  expects?: ExpectedFile[];
  deliver?: string[];
  /** 按用户预算分给这个节点的份额（微美元，ADR 0016 §5）；只是参考，旧节点没有 */
  budgetMicro?: number;
  /** 用户追加要求的前几条已经交给节点了（讨论在下一轮、停止后在继续时带上之后的新要求） */
  notesSeen?: number;
  /** 节点现在的产出是哪次运行交出来的（下游拿这次运行的产出） */
  outputsRunId?: string;
  /** 做几版挑一版（ADR 0026）：这样的节点不自己跑，开 n 个版本子节点，都做完后挑一版 */
  variants?: Variants;
  /** 挑中了第几版、理由（没能按标准挑时给第 1 版，原因写在 warning 里） */
  chosen?: number;
  pickReason?: string;
  /**
   * 正在挑：挑选运行已经开出，占哪个并发池（看图的工具运行占工具子节点的池，AI 比较占 AI 的池）；
   * 没在挑为空或 false
   */
  picking?: 'tool' | 'ai' | false;
  /** 版本子节点：第几版、共几版（AI 版本要走不同的方向） */
  version?: { k: number; n: number };
  /**
   * 展开出来的一条（ADR 0026）：这一条的内容，和它的指纹（内容、做法、用到的上游产出）。
   * 重新展开时指纹没变、上次做成了的沿用，不重做。
   */
  item?: unknown;
  itemHash?: string;
  /**
   * 停下的子节点重新排队等名额（ADR 0026）：轮到它时接着停下前的运行做，而不是从头做。
   * 工作流图里的节点停下后继续时直接开跑，不用这个。
   */
  resumeOnStart?: boolean;
}

/** 干活节点：一个 agent 在持续目标里做完一件事 */
export interface WorkConfig extends CommonConfig {
  /** 要用的外部工具（model：规划员按预算选的型号） */
  tools?: { key: string; uses: number; model?: string }[];
  /** 运行中已经发过几次「超预算请收尾」的提醒（1.5 倍、2 倍各一次，2026-11-07） */
  budgetNudges?: number;
}

/** 讨论发言的一条记录：记下是哪次运行说的，下一轮这位参与者接着那次运行的会话 */
interface TranscriptEntry {
  round: number;
  name: string;
  text: string;
  runId: string;
}

/** 讨论节点：几位参与者来回几轮，最后汇总 */
export interface DiscussionConfig extends CommonConfig {
  participants?: { name: string; model: string; stance: string }[];
  rounds?: number;
  /** 进行到第几轮（还没开始是 0） */
  round?: number;
  transcript?: TranscriptEntry[];
}

/** 工具节点（ADR 0025）：不起 AI，在沙箱里按顺序执行这些工具步骤 */
export interface ToolConfig extends CommonConfig {
  steps?: ToolStep[];
}

/** 展开节点（ADR 0026）：按上游的清单每条开一个子节点 */
export interface ForeachConfig extends CommonConfig {
  over?: string;
  count?: number;
  each?: ForeachBranch;
  /** 实际展开了几条；还没展开（或修改时要重新展开）为空 */
  items?: number;
  /** 清单格式不对、让上游改过几次（最多一次） */
  listRepairs?: number;
}

/** 各种节点的配置。加一种节点：这里加一行，再在 service/kinds 写它的插件并登记 */
export interface KindConfigs {
  work: WorkConfig;
  discussion: DiscussionConfig;
  tool: ToolConfig;
  foreach: ForeachConfig;
}
export type NodeKind = keyof KindConfigs;
export type NodeConfig = KindConfigs[NodeKind];

/** 交给 harness 的完整请求（没送到时按原样重交） */
export interface RunRequestRecord {
  requires?: string[];
  goal?: boolean;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  /** 直接放进 in/ 的小文件（展开节点的 index.json、这一条的 _item.json，ADR 0026） */
  inputs?: RunInputFile[];
  continueFrom?: string;
  /** 工具运行的步骤（ADR 0025） */
  steps?: ToolStep[];
}

/** 讨论发言的轮次和发言人 */
export interface RunMeta {
  resumable?: boolean;
  round?: number;
  participant?: string;
}

/** 规划员排的修改方案里一个节点（ADR 0022）：沿用，或完整节点 + 来自哪个旧节点、怎么做 */
export type RevisionPlanNode =
  { key: string; reuse: string } | (PlanNode & { from?: string; mode: 'continue' | 'fresh' });

/** 进行中的修改（ADR 0022）：规划中没有 plan；通过规划门后带着方案等用户确认 */
export interface RevisionState {
  version: number;
  request: string;
  /** 意见针对的节点（批注、参数所在成果的节点） */
  nodeIds: string[];
  /** 修改前任务的状态：用户不改了就回到这个状态 */
  previousStatus: TaskStatus;
  plan?: {
    summary: string;
    nodes: RevisionPlanNode[];
    edges: { from: string; to: string }[];
    deliverables: Record<string, string>;
  };
  estimateMicro?: number;
  changes?: { key: string; title: string; change: RevisionChange }[];
  /** 用户在做几版的节点上「改用这一版」（ADR 0026）：确认后先换成这一版，再重做受影响的下游 */
  pick?: { nodeId: string; version: number };
}

/** 一样交付物由哪个节点交出 */
export interface Deliverable {
  name: string;
  form: string;
  nodeId: string | null;
  files?: RunOutputFile[];
}

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micro = (name: string) => bigint(name, { mode: 'number' });

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  payerId: uuid('payer_id').notNull(),
  conversationId: uuid('conversation_id'),
  title: text('title').notNull(),
  brief: text('brief').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  attention: jsonb('attention').$type<Attention>(),
  estimateMicro: micro('estimate_micro'),
  spentMicro: micro('spent_micro').notNull().default(0),
  budgetLimitMicro: micro('budget_limit_micro'),
  sheet: jsonb('sheet').$type<TaskSheet>(),
  materials: jsonb('materials').$type<Material[]>().notNull().default([]),
  /** 当前是第几版工作流（ADR 0022） */
  version: integer('version').notNull().default(1),
  /** 进行中的修改（规划中 / 待确认） */
  revision: jsonb('revision').$type<RevisionState>(),
  deliverables: jsonb('deliverables').$type<Deliverable[]>().notNull().default([]),
  plannerRunId: uuid('planner_run_id'),
  planAttempts: integer('plan_attempts').notNull().default(0),
  acceptance: jsonb('acceptance').$type<{
    unmet: string[];
    unchecked?: string[];
    /** 整体验收没满足、退回交付节点改过几次（最多一次）；不返回给用户 */
    repairs?: number;
    /**
     * 这一轮是按用户的修改意见改（ADR 0012）：节点和整体验收只查这条意见改好没有、成品还能不能用，
     * 原任务单在第一轮已经核对过，不再重查；不返回给用户
     */
    revision?: string;
  }>(),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

export const nodes = pgTable('nodes', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  key: text('key').notNull(),
  title: text('title').notNull(),
  kind: text('kind').$type<NodeKind>().notNull(),
  role: text('role').notNull().default(''),
  goal: text('goal').notNull(),
  model: text('model').notNull(),
  config: jsonb('config').$type<NodeConfig>().notNull().default({}),
  status: text('status').$type<NodeStatus>().notNull(),
  attempts: integer('attempts').notNull().default(0),
  reworks: integer('reworks').notNull().default(0),
  userNotes: jsonb('user_notes').$type<string[]>().notNull().default([]),
  warning: text('warning'),
  summary: text('summary'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  currentRunId: uuid('current_run_id'),
  spentMicro: micro('spent_micro').notNull().default(0),
  createdAt: at('created_at').notNull().defaultNow(),
  startedAt: at('started_at'),
  finishedAt: at('finished_at'),
  /** 修改时被方案删掉：从第几版起不在工作流里（ADR 0022）；在工作流里的为空 */
  retiredVersion: integer('retired_version'),
  /** 子节点（ADR 0026）：属于哪个展开节点 / 做几版的节点，排第几 */
  parentId: uuid('parent_id'),
  slot: integer('slot'),
});

export const edges = pgTable('edges', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  fromNodeId: uuid('from_node_id'),
  toNodeId: uuid('to_node_id'),
});

export type NodeRunStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';
/** pick：做几版的节点挑一版（ADR 0026） */
export type NodeRunPurpose = 'work' | 'rework' | 'speech' | 'summary' | 'pick';
export const nodeRuns = pgTable('node_runs', {
  id: uuid('id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  nodeId: uuid('node_id').notNull(),
  attempt: integer('attempt').notNull(),
  purpose: text('purpose').$type<NodeRunPurpose>().notNull(),
  status: text('status').$type<NodeRunStatus>().notNull(),
  summary: text('summary'),
  error: text('error'),
  outputs: jsonb('outputs').$type<RunOutputFile[]>().notNull().default([]),
  meta: jsonb('meta').$type<RunMeta>().notNull().default({}),
  request: jsonb('request').$type<RunRequestRecord>().notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  finishedAt: at('finished_at'),
});

/** 冻结的旧版工作流（ADR 0022）：确认修改时存下，只读查看 */
export const workflowVersions = pgTable('workflow_versions', {
  taskId: uuid('task_id').notNull(),
  version: integer('version').notNull(),
  request: text('request'),
  nodes: jsonb('nodes').$type<NodeBody[]>().notNull(),
  edges: jsonb('edges').$type<{ id: string; from: string | null; to: string | null }[]>().notNull(),
  deliverables: jsonb('deliverables').$type<Deliverable[]>().notNull().default([]),
  spentMicro: micro('spent_micro').notNull().default(0),
  createdAt: at('created_at').notNull(),
  frozenAt: at('frozen_at').notNull().defaultNow(),
});

/** 已经计入花费的模型调用（结算事件按调用 ID 只算一次） */
export const spendRecords = pgTable('spend_records', {
  callId: uuid('call_id').primaryKey(),
  taskId: uuid('task_id').notNull(),
  nodeId: uuid('node_id'),
  chargedMicro: micro('charged_micro').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** 事务发件箱（列名由 service-kit 的 startOutboxRelay 约定） */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  subject: text('subject').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  publishedAt: at('published_at'),
});
