// agent 的接口：模型目录（对外给前端，对内给 conversation 和 task 的规划员）。
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
  /** 系统默认使用的版本，给人看的名字 */
  versionLabel: z.string().nullable(),
  /** 能否使用；不能用的显示「即将接入」 */
  available: z.boolean(),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const ModelList = z.object({ models: z.array(ModelEntry) });

/** 内部：调用模型需要的信息。 */
export const ModelRoute = z.object({
  key: z.string(),
  name: z.string(),
  providerModel: z.string(),
  systemPrompt: z.string(),
});
export type ModelRoute = z.infer<typeof ModelRoute>;

/** 内部：规划员能挑的模型（只列已接入的），节点里用 providerModel */
export const CatalogEntry = z.object({
  key: z.string(),
  name: z.string(),
  vendor: z.string(),
  category: ModelCategory,
  tags: z.array(z.string()),
  providerModel: z.string(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;
export const Catalog = z.object({ models: z.array(CatalogEntry) });

/**
 * 场景经验手册（ADR 0006 §8）：每类场景一份 Markdown——这类任务一般怎么分工、用哪些工具、
 * 交付物长什么样、常见的坑。规划员开工前按任务单挑一份附进说明。
 */
export const Playbook = z.object({
  /** 文件名，如 images */
  key: z.string(),
  /** 第一行的标题，如「图片类」 */
  name: z.string(),
  /** 「适用」那一行：什么样的任务算这一类（给 Jev 判断用） */
  when: z.string(),
  /** 全文 */
  content: z.string(),
});
export type Playbook = z.infer<typeof Playbook>;
export const PlaybookList = z.object({ playbooks: z.array(Playbook) });
