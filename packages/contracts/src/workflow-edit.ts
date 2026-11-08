// 编辑工作流的请求（ADR 0004 §3、§7）：追问节点、改节点、改用另一版（ADR 0026）、接线、「需要处理」时的选择，
// 以及编辑节点时能选的模型和工具。从 task.ts 拆出来，task.ts 原样再导出。
import { z } from 'zod';
import { ToolSteps } from './tool-step.ts';
import {
  ExpectedFile,
  NodeCommon,
  NodeTools,
  OutputPattern,
  Participant,
  TaskCheck,
  Variants,
} from './workflow-plan.ts';

/** 对节点追问 / 补充要求 */
export const NodeMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });

/**
 * 修改还没开始的节点：只改给出的字段；类型不能改。参与者和轮数只对讨论节点有效，工具只对干活节点有效，
 * 步骤只对工具节点有效。
 */
export const UpdateNodeBody = z
  .object({
    title: NodeCommon.title,
    role: z.string().max(2000),
    goal: NodeCommon.goal,
    model: z.string().min(1).max(200),
    checks: z.array(TaskCheck),
    expects: z.array(ExpectedFile),
    requires: NodeCommon.requires,
    deliver: z.array(OutputPattern),
    participants: z.array(Participant).min(2),
    rounds: z.number().int().min(1),
    tools: NodeTools,
    steps: ToolSteps,
    /** 干活、工具节点做几版挑一版（ADR 0026）；null 表示只做一版 */
    variants: Variants.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, '至少要改一项');
export type UpdateNodeBody = z.infer<typeof UpdateNodeBody>;

/** 做几版的节点改用另一版（ADR 0026） */
export const PickVersionBody = z.object({ version: z.number().int().min(1).max(4) });
export type PickVersionBody = z.infer<typeof PickVersionBody>;

/** 新建连线：from 的产出交给 to */
export const CreateEdgeBody = z.object({ from: z.uuid(), to: z.uuid() });

/** 接上线头 / 改连线的一端 */
export const UpdateEdgeBody = z
  .object({ from: z.uuid(), to: z.uuid() })
  .partial()
  .refine((body) => body.from !== undefined || body.to !== undefined, '要给出起点或终点');
export type UpdateEdgeBody = z.infer<typeof UpdateEdgeBody>;

/**
 * 任务「需要处理」时用户的选择：
 * - continue：用现在的结果继续往下做（节点失败时跳过它；花费超限时提高上限接着做）
 * - retry：让失败的节点再试（重做次数重新算）
 * - cancel：取消任务
 */
export const DecisionBody = z.object({ choice: z.enum(['continue', 'retry', 'cancel']) });
export type DecisionBody = z.infer<typeof DecisionBody>;

/** 编辑节点时能选的模型和工具（ADR 0007 §6）：和规划员看到的一样，只列现在能用的 */
export const WorkflowOptions = z.object({
  models: z.array(
    z.object({
      /** 模型目录里的 key，如 deepseek（前端用它找头像） */
      key: z.string(),
      name: z.string(),
      vendor: z.string(),
      /** 节点里写的供应商型号 */
      providerModel: z.string(),
    }),
  ),
  tools: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      unit: z.string(),
      estimateMicro: z.number().int().nonnegative(),
    }),
  ),
});
export type WorkflowOptions = z.infer<typeof WorkflowOptions>;
