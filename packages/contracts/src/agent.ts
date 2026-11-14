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

/**
 * 用户给一个 AI 定的设定（「AI 们」里的设置页），带进它的每一轮：名字（问它叫什么就说这个）、性别（以后开了
 * 语音决定默认的声音）、人格描述、其他要它记住的。没填的用系统默认。
 */
export const AiProfile = z.object({
  name: z.string().trim().min(1).max(20).optional(),
  gender: z.enum(['male', 'female']).optional(),
  persona: z.string().trim().min(1).max(2000).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});
export type AiProfile = z.infer<typeof AiProfile>;

export const ModelEntry = z.object({
  /** 稳定的业务主键，如 claude、gpt；工具用的型号是型号 ID */
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
  /** 能不能私聊（对话 AI 接入了才能）；工具用的型号只能看 */
  available: z.boolean(),
  /** 这个用户给它定的设定（只有对话 AI 有） */
  profile: AiProfile.default({}),
  /** 工具用的型号：哪个工具用它、排第几，如「生图时第一个用」 */
  usage: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ModelList = z.object({ models: z.array(ModelEntry) });

/** 设置页保存：用哪一档、设定（整份替换；不填的项回到系统默认） */
export const SaveAiBody = z.object({ tier: ModelTier, profile: AiProfile });
export type SaveAiBody = z.infer<typeof SaveAiBody>;

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
