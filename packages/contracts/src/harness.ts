// harness 的内部接口（只给 task 等内部服务用，gateway 不转发）：启动一次 agent 运行、查进度、追问、停止、取消。
import { z } from 'zod';
import { UiTestReport, BrowserTestResult } from './ui-test.ts';

/** 实际运行镜像的软件探测；只描述本地环境，不代表外部供应商能力。 */
export const ExecutionEnvironment = z.object({
  image: z.string(),
  imageId: z.string(),
  software: z.record(z.string(), z.string()),
  capabilities: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironment>;

export const RunStatus = z.enum([
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  /** 用户点了停止：已经做出来的产出存下了，会话在持久工作目录里，可以用 continueFrom 接着做 */
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
  /** 工作节点使用原生持久目标；普通发言仍可只跑一轮。 */
  goal: z.boolean().default(false),
  /** 思考强度：max 用模型支持的最高档（规划员）；不给时最高到 high */
  reasoningEffort: z.enum(['max']).optional(),
  /** 规划所需的本地能力；预检失败在登记和冻结之前返回。 */
  requires: z.array(z.string().min(1).max(100)).default([]),
  /** 交给 agent 的完整任务说明 */
  prompt: z.string().min(1).max(200_000),
  inputs: z.array(RunInputFile).default([]),
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
    .default([]),
  /**
   * 用户给的素材：开沙箱前由 harness 向 canvas 取出，放在沙箱里的 path（如 materials/照片.jpg）。
   * 是不是这个用户的文件，conversation 收附件时已经核对过。
   */
  materials: z
    .array(
      z.object({
        uploadId: z.uuid(),
        path: z
          .string()
          .min(1)
          .max(300)
          .regex(
            /^materials\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\n]+$/,
            '必须放在 materials/ 下，不能有 ..',
          ),
      }),
    )
    .default([]),
  /**
   * 接着之前某次运行做：挂上它的持久工作目录（会话、out/、装好的依赖都在），AI 记得前面做到哪了；
   * 没另给 inputsFrom 就沿用它的。用于关卡退回修改、停止后继续、修改、讨论的下一轮。
   * 只能接同一付费人、已结束、工作目录还在的运行；工作目录不在了返回 409 {@link WORKSPACE_UNAVAILABLE}。
   */
  continueFrom: z.uuid().optional(),
});
export type StartRunBody = z.input<typeof StartRunBody>;

/**
 * 接着的那次运行的持久工作目录已经不在了（持久卷被清掉）：接不上原会话。
 * 调用方应改成重新开一个会话做，把上一版产出作为输入带上（task：ADR 0022 的「重新做」）。
 */
export const WORKSPACE_UNAVAILABLE = 'workspace_unavailable';

/** 运行产出的文件（沙箱里 /workspace/out 下的内容） */
export const RunOutputFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type RunOutputFile = z.infer<typeof RunOutputFile>;

export const RunBody = z.object({
  id: z.uuid(),
  payerId: z.uuid(),
  taskId: z.uuid().nullable(),
  nodeId: z.uuid().nullable(),
  model: z.string(),
  status: RunStatus,
  /** 持久工作目录还在，可以用 continueFrom 接着这次运行的会话做 */
  resumable: z.boolean().optional(),
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

/**
 * 一次运行产出包的临时下载链接（给 inspector 检查用，ADR 0024）：只给这次运行的付费人和任务，
 * 运行没有产出时 404。
 */
export const OutputsLinkBody = z.object({ payerId: z.uuid(), taskId: z.uuid() });
export const OutputsLink = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type OutputsLink = z.infer<typeof OutputsLink>;

export const ApplicationCheckResult = z.object({
  application: BrowserTestResult.shape.application,
  passed: z.boolean(),
  reason: z.string().nullable(),
  frameCaptured: z.boolean(),
  report: UiTestReport.optional(),
  inputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** 平台截取的画面（打开后的首屏 opening.jpg 与测试步骤截图），不是节点自述 */
  screenshots: z.array(z.object({ name: z.string().max(100), base64: z.string() })).optional(),
});
export type ApplicationCheckResult = z.infer<typeof ApplicationCheckResult>;
