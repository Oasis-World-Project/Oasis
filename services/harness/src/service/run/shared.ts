// 运行服务（run-service.ts）分成几块：执行一次运行（execute）、沙箱和对象存储之间搬文件（storage）、
// 停止 / 取消 / 重启接管（control）、读产出和过程（outputs）。各块通过同一个 RunContext 互相调用，
// 这里只放它们共用的类型、状态和小工具，免得文件之间循环 import。
import type { Readable } from 'node:stream';
import type {
  ExecutionEnvironment,
  RunBody,
  RunEventBody,
  StartRunBody,
} from '@oasis/contracts/harness';
import type { ModelCapabilities } from '@oasis/contracts/model-gateway';
import type { Logger, ObjectStore, ServiceClient, StreamFile } from '@oasis/service-kit';
import type { AgentConnection, SandboxPackages } from '../../adapter/dsh.ts';
import type { Executor, Sandbox } from '../../executor/executor.ts';
import type { Run, RunOutcome, RunsRepo } from '../../repo/runs-repo.ts';
import type { InspectionLimits } from '../file-inspection.ts';

export interface RunDeps {
  repo: RunsRepo;
  executor: Executor;
  store: ObjectStore;
  modelGateway: ServiceClient;
  /** 取用户上传的素材（ADR 0007 §4） */
  canvas: ServiceClient;
  /** 一次运行的素材加起来最多多大 */
  materialsMaxBytes?: number;
  transferTimeoutMs?: number;
  modelBaseUrl: string;
  packages: SandboxPackages;
  batchEnv?: Record<string, string>;
  inspectionLimits?: InspectionLimits;
  maxConcurrent: number;
  /** 显式验收超时；生产调用不设置。 */
  timeoutMs?: number;
  leaseMs?: number;
  goalRoundWindow?: number;
  keyTtlSeconds?: number;
  /** 沙箱的 CPU 核数（算力按 时长 × 核数 计费） */
  cores: number;
  outputMaxBytes?: number;
  serviceName: string;
  logger: Logger;
}

type Status = RunBody['status'];

/** 放进 out/ 的占位文件：保证目录存在且属于沙箱用户，不算产出 */
export const KEEP_FILE = '.oasis-keep';
export const audioPath = /\.(wav|mp3|m4a|flac|ogg|webm|aac)$/i;
export const videoPath = /\.(mp4|mov|mkv|avi|webm|mlt|srt)$/i;
/** 批次恢复状态和工具的中间文件在 out/ 里，会随产出包存下，但不是成果，也不传给下游节点。 */
export const isPrivateOutput = (path: string) =>
  path === KEEP_FILE ||
  ['.oasis-batches', '.oasis-tools'].some((dir) => path === dir || path.startsWith(`${dir}/`));

/** 这个进程里正在执行的一次运行 */
export interface LiveRun {
  readonly abort: AbortController;
  agent?: AgentConnection;
  /** 已交给 dsh 的用户消息条数（含最初的任务说明） */
  prompts: number;
  /** 已经开始收尾，不再接受追问 */
  closing: boolean;
  nextSeq: number;
  /** AI 最近说的一句话，结束时作为 summary */
  lastText?: string;
  /** 事件按顺序写库 */
  writes: Promise<void>;
  /** 被停止时从沙箱里取出的产出 */
  saved?: Promise<Saved>;
  done: Promise<void>;
  sessionId?: string;
  suspended?: boolean;
}

/** 新登记的一次运行（在这个进程里执行） */
export const newLiveRun = (nextSeq: number, sessionId: string): LiveRun => ({
  abort: new AbortController(),
  prompts: 0,
  closing: false,
  nextSeq,
  writes: Promise.resolve(),
  done: Promise.resolve(),
  sessionId,
});

export interface Saved {
  outputs?: { key: string; files: { path: string; size: number }[] };
}

/** 取消、停止、超时、服务关闭时中止运行的原因 */
export class StopRun extends Error {
  readonly status: Status;
  constructor(status: Status, message: string) {
    super(message);
    this.status = status;
  }
}

/** 存下来的产出 → 运行结局里的字段 */
export const savedOutcome = (saved: Saved) => ({
  outputs: saved.outputs?.files.filter((f) => !isPrivateOutput(f.path)) ?? [],
  outputKey: saved.outputs?.key ?? null,
});

/** resumable：这次运行的持久工作目录还在，可以接着它的会话做 */
export function toRunBody(run: Run, resumable: boolean): RunBody {
  return {
    id: run.id,
    payerId: run.payerId,
    taskId: run.taskId,
    nodeId: run.nodeId,
    model: run.model,
    status: run.status,
    resumable,
    error: run.error,
    outputs: run.outputs,
    summary: run.summary,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** 简单的并发闸门：同时最多 limit 个运行在用沙箱，其余排队。 */
export function createGate(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async acquire(): Promise<() => void> {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      return () => {
        active -= 1;
        waiting.shift()?.();
      };
    },
  };
}

type Material = Required<StartRunBody>['materials'][number];

/** 开跑前查到的：模型能力目录和执行环境 */
interface Catalog {
  models: ModelCapabilities[];
  environment?: ExecutionEnvironment;
}

/** 运行服务在这个进程里的状态 */
interface RunState {
  live: Map<string, LiveRun>;
  /** 正在登记新运行的会话（同一会话不能同时开两次运行） */
  sessions: Set<string>;
  /** 用户的停止 / 取消意图（接管期间也要生效） */
  controlRequests: Map<string, 'stop' | 'cancel'>;
  controlWrites: Map<string, Promise<void>>;
  /** 服务正在关闭 */
  closing: boolean;
  gate: ReturnType<typeof createGate>;
}

export interface RunContext {
  deps: RunDeps;
  state: RunState;
  /** 取运行记录；没有就 404 */
  owned(id: string): Promise<Run>;
  /** 对外的运行信息：能不能接着做看持久工作目录还在不在 */
  bodyOf(row: Run): Promise<RunBody>;

  // ---- 执行（execute.ts）
  /** 准入：执行环境有所需能力、模型在执行目录里 */
  admit(model: string, requires?: string[]): Promise<Catalog>;
  /** 按顺序记一条运行事件 */
  record(
    runId: string,
    run: LiveRun,
    kind: RunEventBody['kind'],
    data: Record<string, unknown>,
  ): void;
  /** 跑完一次运行的整个生命周期；recovering：接管重启前已经开始的运行（工作目录里已有输入） */
  execute(
    row: Run,
    inputs: { path: string; content: Buffer }[],
    materials: Material[],
    run: LiveRun,
    mode: { goal: boolean; reasoningEffort?: 'max' },
    catalog: Catalog,
    recovering?: boolean,
  ): Promise<void>;
  /** 写结局并发出 harness.run.finished */
  finish(row: Run, outcome: Omit<RunOutcome, 'finishedAt'>): Promise<void>;

  // ---- 搬文件（storage.ts）
  /** 取出产出（会话和工作目录在持久卷里，不用存） */
  save(sandbox: Pick<Sandbox, 'readArchive' | 'inspectMedia'>, id: string): Promise<Saved>;
  /** 上游运行的产出：解出来放到 in/<as>/ 下 */
  upstreamFiles(row: Run): Promise<{ dir: string; tar: Readable }[]>;
  /** 用户给的素材：向 canvas 取出来，放到 materials/ 下 */
  materialFiles(materials: Material[], runId: string, ownerId: string): Promise<StreamFile[]>;

  // ---- 控制（control.ts）
  /** 单实例启动接管 */
  recover(): Promise<void>;
}
