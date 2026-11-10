// 工具服务（tool-service.ts）分成几块：一次工具调用的计量（tool-call）、长任务的后台推进（tool-jobs）、
// 长任务的对外接口（tool-job-api）。这里放它们共用的依赖和接口，免得文件之间循环 import。
import type { Logger, ObjectStore } from '@oasis/service-kit';
import type { BrowserStackClient } from '../adapters/browserstack.ts';
import type { FalClient } from '../adapters/fal.ts';
import type { ProviderClient } from '../adapters/openrouter.ts';
import type { RenderClient } from '../adapters/runpod.ts';
import type { SearchClient } from '../adapters/tavily.ts';
import type { ToolJob, ToolJobsRepo } from '../repo/tool-jobs-repo.ts';
import type { AvatarCatalog } from './avatar-catalog.ts';
import type { Caller, Meter } from './metering.ts';
import type { ModelScopeService } from './model-scope.ts';
import type { BrowserChecks } from './tools/kit.ts';
import type { ToolConfig, ToolDef } from './tools.ts';

export interface ToolServiceDeps {
  /** 单价要不要参考调用记录（开发阶段关掉，只用供应商价格和目录兜底值） */
  estimateFromHistory?: boolean;
  /** 浏览器检查：inspector 和检查浏览器的算力（ADR 0024） */
  checks?: BrowserChecks;
  browserstack?: BrowserStackClient;
  openrouter: ProviderClient;
  tavily: SearchClient;
  meter: Meter;
  /** 模型范围：替哪个用户挑模型，就按他的范围过滤（ADR 0027） */
  scope: Pick<ModelScopeService, 'filterFor'>;
  jobs: ToolJobsRepo;
  store: ObjectStore;
  fal?: FalClient;
  render?: RenderClient;
  resultMaxBytes?: number;
  retentionMs?: number;
  submitTimeoutMs?: number;
  /** 长任务最多等多久 */
  jobTimeoutMs: number;
  config: ToolConfig;
  logger: Logger;
  /** 数字人形象和声音目录（ADR 0013）；只读、不花钱，不走计量 */
  avatarCatalog?: AvatarCatalog;
}

/** 长任务的冻结比等待上限多留这么久，免得结算前就被自动退回 */
export const HOLD_MARGIN_MS = 10 * 60_000;

export interface ToolContext {
  deps: ToolServiceDeps;
  byKey: Map<string, ToolDef>;
  /** 工具依赖的供应商配好了没有 */
  configured(tool: ToolDef): boolean;
  /** 这个工具给这个用户用的模型：按他的模型范围过滤（ADR 0027） */
  usableModels(tool: ToolDef, payerId: string | undefined): Promise<string[]>;
  /** 长任务结果文件在对象存储里的位置 */
  resultKey(jobId: string, fileId: string): string;

  // ---- 长任务后台推进（tool-jobs.ts）
  /** 推进一个长任务（同一个任务同时只推进一份） */
  processOne(id: string): Promise<void>;
  /** 巡检：推进待处理的长任务，清理过期和所属任务已删除的结果 */
  tick(): Promise<void>;
  /** 收下渲染的 GPU 费用回执 */
  acceptRenderEvidence(
    job: ToolJob,
    evidence: { costMicro: number; billId: string; stopped: boolean },
  ): Promise<void>;

  // ---- 长任务对外接口（tool-job-api.ts）
  /** 调用方自己的长任务；所属任务已删除时 410 */
  ownedJob(caller: Caller, id: string): Promise<ToolJob>;
}
