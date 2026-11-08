// 工具定义共用的部分（ADR 0006）：每个工具 = 参数校验 + 目录信息 + 怎么调供应商、怎么算钱。
import type { Readable } from 'node:stream';
import type { ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { BrowserStackClient } from '../../adapters/browserstack.ts';
import type { FalClient } from '../../adapters/fal.ts';
import type { ProviderClient } from '../../adapters/openrouter.ts';
import type { RenderClient } from '../../adapters/runpod.ts';
import type { SearchClient } from '../../adapters/tavily.ts';
import { USD_TO_MICRO, type CostSource } from '../pricing.ts';

/** 工具交回给 AI 的文字最多这么长 */
export const MAX_TEXT = 20_000;

export interface ToolConfig {
  imageModels: string[];
  visionModels: string[];
  visionMaxTokens: number;
  fetchMaxBytes: number;
  videoModels: string[];
  speechModels: string[];
  transcribeModels: string[];
  jevModel: string;
  /** Tavily 每个积分多少钱（微美元） */
  tavilyCreditMicro: number;
  /** 配音拿不到实际花费时，每个字估多少钱（微美元） */
  speechMicroPerChar: number;
  musicModels?: string[];
  musicMicroPerGeneration?: number;
  geometryModels?: string[];
  geometryMicroPerGeneration?: number;
}

interface ToolDeps {
  harness?: ServiceClient;
  taskId?: string;
  /** 调用工具的那次节点运行（app.check 读它沙箱里的当前成果） */
  runId?: string;
  browserstack?: BrowserStackClient;
  payerId?: string;
  render?: RenderClient;
  openrouter: ProviderClient;
  tavily: SearchClient;
  fal?: FalClient;
  config: ToolConfig;
  /** 发请求给供应商：还没产生费用就失败时，由计量那边退回冻结并抛出给调用方看的错误 */
  upstream: (request: () => Promise<Response>) => Promise<Response>;
  signal: AbortSignal;
  /** 供应商终态回执的持久副本：供应商只保留一段时间，取结果慢时也不能丢 */
  receipt?: { saved?: unknown; save(value: unknown): Promise<void> };
}

interface ToolOutcome {
  text: string;
  data?: unknown;
  files: {
    name: string;
    mediaType: string;
    base64?: string;
    body?: Readable;
    size?: number;
    sha256?: string;
  }[];
  cost: { costMicro: number; source: CostSource };
}

interface ToolBase {
  key: string;
  name: string;
  description: string;
  usage: string;
  unit: string;
  estimateMicro: number;
  /** 调用前冻结多少（微美元），按参数算 */
  holdMicro: (args: Record<string, unknown>) => number;
  /** 依赖哪个供应商（没配 Key 就不能用） */
  provider: 'openrouter' | 'tavily' | 'fal' | 'runpod' | 'browserstack' | 'harness';
  /** 可以选的模型；不需要模型的工具返回空 */
  models: (config: ToolConfig) => string[];
  args: z.ZodType<Record<string, unknown>>;
  /** 这次调用记在哪个模型名下（调用记录、地区检查用） */
  modelOf: (args: Record<string, unknown>, models: string[]) => string;
}

/** 马上出结果的工具 */
interface QuickTool extends ToolBase {
  long: false;
  run: (deps: ToolDeps, args: Record<string, unknown>, model: string) => Promise<ToolOutcome>;
}

/** 长任务的进度 */
type LongState =
  | { state: 'pending' }
  | { state: 'failed'; error: string }
  | { state: 'uncertain'; error: string }
  | {
      state: 'completed';
      outcome: Omit<ToolOutcome, 'cost'> & { cost: ToolOutcome['cost'] | null };
    };

/** 长任务（视频）：先提交拿到供应商的任务号，之后查进度，做好了再取结果 */
interface LongTool extends ToolBase {
  deferred?: boolean;
  long: true;
  start: (deps: ToolDeps, args: Record<string, unknown>, model: string) => Promise<string>;
  check: (deps: ToolDeps, providerJobId: string) => Promise<LongState>;
  cancel?: (deps: ToolDeps, providerJobId: string) => Promise<void>;
}

export type ToolDef = QuickTool | LongTool;

const usd = (value: number) => Math.round(value * USD_TO_MICRO);
export const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}\n……（太长，后面省略了）` : text;
export const optionalModel = z.string().min(1).max(200).optional();
/** 指定了模型就用指定的，否则用可选模型里的第一个 */
export const pickModel = (args: Record<string, unknown>, models: string[]) =>
  typeof args.model === 'string' ? args.model : (models[0] ?? '');

/** 不接受远程 URL；图片经既有上传/沙箱通路传入，限制请求和内存占用。 */
export const InputImages = z
  .array(
    z
      .object({
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        base64: z.string().min(4).max(28_000_000),
      })
      .refine((image) => {
        if (image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))
          return false;
        const bytes = Buffer.from(image.base64, 'base64');
        if (image.mediaType === 'image/png')
          return (
            bytes.length >= 24 &&
            bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          );
        if (image.mediaType === 'image/jpeg')
          return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        return (
          bytes.length >= 16 &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP'
        );
      }, '图片编码、格式或文件签名无效'),
  )
  .min(1)
  .max(4)
  .refine(
    (images) =>
      images.reduce((n, image) => n + Buffer.byteLength(image.base64, 'base64'), 0) <=
      20 * 1024 * 1024,
    '图片总大小超过 20 MiB',
  );

/** 实际花费拿不到时的估算 */
export const estimate = (costMicro: number) => ({ costMicro, source: 'estimate' as const });
export const provider = (costUsd: number) => ({
  costMicro: usd(costUsd),
  source: 'provider' as const,
});
