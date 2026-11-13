// 用户对工作流能做的操作：给一样成果发话、改用另一版（ADR 0026）、「需要处理」时的选择。
// 节点和连线不能编辑（ADR 0030 §3.2）。从 task.ts 拆出来，task.ts 原样再导出。
import { z } from 'zod';

/** 对节点追问 / 补充要求 */
export const NodeMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });

/** 做几版的节点改用另一版（ADR 0026） */
export const PickVersionBody = z.object({ version: z.number().int().min(1).max(4) });
export type PickVersionBody = z.infer<typeof PickVersionBody>;

/**
 * 任务「需要处理」时用户的选择：
 * - continue：用现在的结果继续往下做（节点失败时跳过它）
 * - retry：让失败的节点再试（重做次数重新算）
 * - cancel：取消任务
 */
export const DecisionBody = z.object({ choice: z.enum(['continue', 'retry', 'cancel']) });
export type DecisionBody = z.infer<typeof DecisionBody>;

/** 工作流页显示用的名字：节点里写的供应商型号是哪个 AI（前端用 key 找头像）、工具叫什么 */
export const WorkflowNames = z.object({
  models: z.array(z.object({ key: z.string(), name: z.string(), providerModel: z.string() })),
  tools: z.array(z.object({ key: z.string(), name: z.string() })),
});
export type WorkflowNames = z.infer<typeof WorkflowNames>;
