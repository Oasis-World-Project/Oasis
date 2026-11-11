// 工具定义共用的部分（ADR 0006）：每个工具 = 参数校验 + 目录信息 + 怎么调供应商、怎么算钱。
import type { Readable } from 'node:stream';
import type { ToolArgSpec } from '@oasis/contracts/tool-args';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import type { BrowserStackClient } from '../../adapters/browserstack.ts';
import type { FalClient } from '../../adapters/fal.ts';
import type { ProviderClient } from '../../adapters/openrouter.ts';
import type { RenderClient } from '../../adapters/runpod.ts';
import type { SearchClient } from '../../adapters/tavily.ts';
import type { ComputeService } from '../compute-service.ts';
import { USD_TO_MICRO, type CostSource } from '../pricing.ts';

/** 工具交回给 AI 的文字最多这么长 */
export const MAX_TEXT = 20_000;

export interface ToolConfig {
  imageModels: string[];
  /** 看图、看视频、听音频的型号，按顺序试；每个型号读得了哪几种由供应商目录说了算 */
  inspectModels: string[];
  inspectMaxTokens: number;
  fetchMaxBytes: number;
  videoModels: string[];
  speechModels: string[];
  transcribeModels: string[];
  jevModel: string;
  /** jevModel 用不了时（如「只用国内模型」）回答快速判断的聊天模型，按顺序 */
  decideChatModels: string[];
  /** Tavily 每个积分多少钱（微美元） */
  tavilyCreditMicro: number;
  /** 配音拿不到实际花费时，每个字估多少钱（微美元） */
  speechMicroPerChar: number;
  /** fal 上生音乐、图生 3D 的型号，按顺序；只认各自工具里对接过的（ADR 0029 §8） */
  musicModels?: string[];
  geometryModels?: string[];
}

/**
 * 浏览器检查（website.test、app.check，ADR 0024）：inspector 开检查浏览器，
 * 算力由网关先冻结、按 inspector 报回的实际用时结算。
 */
export interface BrowserChecks {
  inspector: ServiceClient;
  compute: Pick<ComputeService, 'hold' | 'settle'>;
  /** 检查浏览器用几核、一次冻结多久的算力（检查本身不设时限，超出的部分不再计费） */
  cores: number;
  maxMs: number;
}

export interface ToolDeps {
  checks?: BrowserChecks;
  taskId?: string;
  /** 调用工具的那次节点运行 */
  runId?: string;
  nodeId?: string;
  logger?: Logger;
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
  provider: 'openrouter' | 'tavily' | 'fal' | 'runpod' | 'browserstack' | 'inspector';
  /** 可以选的模型；不需要模型的工具返回空 */
  models: (config: ToolConfig) => string[];
  /** 型号一次的标价（微美元）：供应商不按调用回报花费的工具（fal）写上，目录按它列各型号的单价 */
  priceMicro?: (model: string) => number | undefined;
  args: z.ZodType<Record<string, unknown>>;
  /**
   * 命令行参数（ADR 0025）：`oasis-tool <工具> --名字 值` 能写哪些。沙箱里的 oasis-tool 把文件参数
   * （path、paths）读成内容再交给 args 校验；规划门按它校验工具节点，工作流页按它展示。
   */
  cli: ToolArgSpec[];
  /** 计费单位数写在哪个参数里（视频的秒数、生图的张数）；估价用 */
  per?: { arg: string; default: number };
  /** 这次调用记在哪个模型名下（调用记录、地区检查用） */
  modelOf: (args: Record<string, unknown>, models: string[]) => string;
}

/** 选型号的参数：各个按型号计价的工具都有 */
export const MODEL_ARG: ToolArgSpec = {
  name: 'model',
  kind: 'text',
  description: '型号（不写用目录里的第一个）',
};

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

const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const base64 = z.string().min(4).max(28_000_000);

/**
 * 要看、要听的文件（media.inspect）：图片、视频、音频都经既有上传/沙箱通路传入，不接受远程 URL。
 * kind 对应供应商目录里型号的输入种类（image、video、audio），用来挑读得了它们的型号。
 */
export const InputMedia = z
  .array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('image'),
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        base64,
      }),
      z.object({
        kind: z.literal('video'),
        mediaType: z.enum(['video/mp4', 'video/webm', 'video/quicktime']),
        base64,
      }),
      z.object({
        kind: z.literal('audio'),
        format: z.enum(['mp3', 'wav', 'm4a', 'flac', 'ogg']),
        base64,
      }),
    ]),
  )
  .min(1)
  .max(4)
  .refine(
    (files) =>
      files.reduce((n, file) => n + Buffer.byteLength(file.base64, 'base64'), 0) <= MEDIA_MAX_BYTES,
    '文件总大小超过 20 MiB',
  )
  .refine(
    (files) =>
      InputImages.safeParse(
        files.flatMap((f) =>
          f.kind === 'image' ? [{ mediaType: f.mediaType, base64: f.base64 }] : [],
        ),
      ).success || !files.some((f) => f.kind === 'image'),
    '图片编码、格式或文件签名无效',
  );
export type InputMedia = z.infer<typeof InputMedia>;

/** 实际花费拿不到时的估算 */
export const estimate = (costMicro: number) => ({ costMicro, source: 'estimate' as const });
export const provider = (costUsd: number) => ({
  costMicro: usd(costUsd),
  source: 'provider' as const,
});
