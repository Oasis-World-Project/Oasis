// harness 的内部接口（只给 task 等内部服务用，gateway 不转发）：启动一次 agent 运行、查进度、追问、停止、取消。
import { z } from 'zod';

export const RunStatus = z.enum([
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  /** 用户点了停止：已经做出来的产出和会话都存下了，可以用 continueFrom 接着做 */
  'stopped',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** 放进沙箱 /workspace/in 的输入文件（5.1 先内联传；之后由画布提供下载地址） */
export const RunInputFile = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/, '必须是不含 .. 的相对路径'),
  contentBase64: z.string(),
});

export const StartRunBody = z.object({
  /** 调用方可以自带运行 ID（便于幂等）；不给就由 harness 生成 */
  runId: z.uuid().optional(),
  payerId: z.uuid(),
  taskId: z.uuid().optional(),
  nodeId: z.uuid().optional(),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
  /** 交给 agent 的完整任务说明 */
  prompt: z.string().min(1).max(200_000),
  inputs: z.array(RunInputFile).max(200).default([]),
  /**
   * 把之前某次运行的产出放进本次沙箱的 in/<as>/ 下（工作流里上游节点交给下游）。
   * 只能引用同一付费人、已成功的运行。
   */
  inputsFrom: z
    .array(
      z.object({
        runId: z.uuid(),
        as: z
          .string()
          .regex(
            /^[\p{L}\p{N}_.-]{1,64}$/u,
            '只能用字母、数字、下划线、点和短横线，最长 64 个字符',
          ),
      }),
    )
    .max(20)
    .default([]),
  /**
   * 接着之前某次运行做：放回它的会话（AI 记得前面聊过什么）、它的产出（放回 out/）和它的输入。
   * 用于关卡退回修改、停止后继续、讨论的下一轮。只能接同一付费人、已结束的运行。
   */
  continueFrom: z.uuid().optional(),
});
export type StartRunBody = z.input<typeof StartRunBody>;

/** 运行产出的文件（沙箱里 /workspace/out 下的内容） */
export const RunOutputFile = z.object({ path: z.string(), size: z.number().int().nonnegative() });
export type RunOutputFile = z.infer<typeof RunOutputFile>;

export const RunBody = z.object({
  id: z.uuid(),
  payerId: z.uuid(),
  taskId: z.uuid().nullable(),
  nodeId: z.uuid().nullable(),
  model: z.string(),
  status: RunStatus,
  error: z.string().nullable(),
  outputs: z.array(RunOutputFile),
  /** AI 最后说的一句话（下游节点和界面用） */
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RunBody = z.infer<typeof RunBody>;

/**
 * 运行过程中的事件（已从 dsh 的原始事件翻译过来，调用方不需要认识 dsh）。
 * - status：运行时整体变为忙 / 空闲
 * - user_message：用户的任务说明或追问
 * - assistant_text：AI 说的话
 * - tool_call / tool_result：AI 调用工具及结果（内容过长会截断）
 * - turn_end：一轮结束及原因
 * - error：运行出错
 */
export const RunEventKind = z.enum([
  'status',
  'user_message',
  'assistant_text',
  'tool_call',
  'tool_result',
  'turn_end',
  'error',
]);
export type RunEventKind = z.infer<typeof RunEventKind>;

export const RunEventBody = z.object({
  seq: z.number().int().nonnegative(),
  kind: RunEventKind,
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type RunEventBody = z.infer<typeof RunEventBody>;

export const RunEventList = z.object({ events: z.array(RunEventBody) });

/** 用户在运行中追问或补充要求：排在当前这一轮之后处理，带着完整上下文 */
export const RunMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });

/** 某次运行的文字类产出（给关卡检查用；总长截断） */
export const RunTextsBody = z.object({
  files: z.array(z.object({ path: z.string(), text: z.string() })),
  truncated: z.boolean(),
});
export type RunTextsBody = z.infer<typeof RunTextsBody>;
