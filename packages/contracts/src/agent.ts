// agent 的接口：模型目录（对外给前端，对内给 conversation），以及用户给 AI 们的设置。
import { z } from 'zod';

export const ModelCategory = z.enum([
  'llm',
  'image',
  'vision',
  'video',
  'audio',
  'embedding',
  '3d',
  'other',
]);

/** 档位：快速（默认）、均衡、强力、最强。一个 AI 每档最多一个型号 */
export const ModelTier = z.enum(['fast', 'balanced', 'strong', 'max']);
export type ModelTier = z.infer<typeof ModelTier>;

/** 一个 AI 可选的一个型号（对外不给上游型号 ID，按档位选） */
export const ModelOption = z.object({
  tier: ModelTier,
  /** 给人看的名字，如 DeepSeek V4 Pro */
  label: z.string(),
  /** 大概单价：每百万 token 多少美元 */
  inputPrice: z.number().nonnegative(),
  outputPrice: z.number().nonnegative(),
  /** 量过的结果或提醒（如「做任务较弱」） */
  note: z.string().optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const ModelEntry = z.object({
  /** 稳定的业务主键，如 claude、gpt */
  key: z.string(),
  name: z.string(),
  vendor: z.string(),
  category: ModelCategory,
  tags: z.array(z.string()),
  /** 头像上的字母，如 Cl、GPT */
  mono: z.string(),
  /** 头像光色（数据，不是样式代码） */
  glow: z.string(),
  /** 可选的型号，第一个是默认 */
  options: z.array(ModelOption),
  /** 这个用户现在用的档位（没选过是第一个）；还没接入的为 null */
  tier: ModelTier.nullable(),
  /** 现在用的型号给人看的名字 */
  versionLabel: z.string().nullable(),
  /** 能否使用；不能用的显示「即将接入」 */
  available: z.boolean(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ModelList = z.object({ models: z.array(ModelEntry) });

/** 给一个 AI 换档位 */
export const ChooseTierBody = z.object({ tier: ModelTier });

/**
 * 用户给 AI 们的设置。domesticOnly：只用国内厂商的模型——国外厂商的 AI 暂停（聊天记录都在，
 * 关掉就能接着聊），各工具也只用国内厂商的型号；关着（默认）时不排除任何模型。
 */
export const AiSettings = z.object({ domesticOnly: z.boolean() });
export type AiSettings = z.infer<typeof AiSettings>;

/** 内部：开一轮需要的信息（这个 AI 用哪个型号、人设，以及这个用户的设置）。 */
export const ModelRoute = z.object({
  key: z.string(),
  name: z.string(),
  providerModel: z.string(),
  systemPrompt: z.string(),
  domesticOnly: z.boolean(),
});
export type ModelRoute = z.infer<typeof ModelRoute>;
