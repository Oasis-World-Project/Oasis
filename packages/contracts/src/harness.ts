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

export const AudioCheckResult = z.object({
  files: z
    .array(
      z.object({
        path: z.string(),
        valid: z.boolean(),
        size: z.number().int().nonnegative().optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        durationMs: z.number().int().positive().optional(),
        codec: z.string().optional(),
        sampleRate: z.number().positive().optional(),
        channels: z.number().int().positive().optional(),
        peakDb: z.number().optional(),
        error: z.string().optional(),
      }),
    )
    .max(100),
  unchecked: z.array(z.string()).max(1000),
});

/** 视频/平台工程的受信检查；语义画面与 Shotcut 实际重导出不由解码结果代替。 */
export const VideoCheckResult = z.object({
  files: z
    .array(
      AudioCheckResult.shape.files.element.extend({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        frameRate: z.number().positive().optional(),
        audioCodec: z.string().optional(),
        audioDurationMs: z.number().int().nonnegative().optional(),
        avDeltaMs: z.number().int().optional(),
        blackIntervals: z
          .array(z.object({ startMs: z.number(), endMs: z.number() }))
          .max(200)
          .optional(),
        silentIntervals: z
          .array(z.object({ startMs: z.number(), endMs: z.number() }))
          .max(200)
          .optional(),
        samples: z
          .array(
            z.object({
              atMs: z.number().nonnegative(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(3)
          .optional(),
        projectSources: z.number().int().positive().optional(),
        subtitleCues: z.number().int().nonnegative().optional(),
      }),
    )
    .max(100),
  unchecked: z.array(z.string()).max(1000),
});

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

/** 某次运行的文字类产出（给关卡检查用；总长截断） */
export const RunTextsBody = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      text: z.string(),
      valid: z.boolean().optional(),
      error: z.string().optional(),
      warning: z.string().optional(),
      /** 已核验的证据范围；范围外的语义需要其他独立证据。 */
      evidenceScope: z.enum(['geometry', 'decoded-audio', 'decoded-video']).optional(),
      errorKind: z.enum(['invalid', 'incomplete']).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      truncated: z.boolean().optional(),
    }),
  ),
  truncated: z.boolean(),
});

/** 只解析已上传素材，不开启 agent，不接受 URL 或本机路径。 */
export const MaterialInspectBody = z.object({
  ownerId: z.uuid(),
  ids: z.array(z.uuid()).max(20),
  maxChars: z.number().int().min(1).max(50_000).default(30_000),
});
export type MaterialInspectBody = z.infer<typeof MaterialInspectBody>;
export const MaterialInspection = z.object({
  uploadId: z.uuid(),
  name: z.string(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  text: z.string(),
  status: z.enum(['complete', 'partial', 'unsupported', 'failed']),
  reason: z.string().optional(),
  /** 图片素材（如批注截图）没有正文，原图交给关卡的看图检查（2026-11-05） */
  image: z
    .object({
      mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      base64: z.string(),
    })
    .optional(),
});
export const MaterialInspectResult = z.object({ files: z.array(MaterialInspection).max(20) });
export type MaterialInspectResult = z.infer<typeof MaterialInspectResult>;
export type RunTextsBody = z.infer<typeof RunTextsBody>;

/** 先在该次运行的输出集合中选取，再解析正文；空清单不回退为全部文件。 */
export const RunInspectBody = z.object({
  paths: z.array(z.string().min(1).max(500)).max(1000),
  maxChars: z.number().int().min(1).max(50_000).default(8000),
});

/** 运行结束后独立开启的私有预览；应用脚本只在服务端运行。 */
export const PreviewSessionBody = z.object({
  id: z.uuid(),
  artifactId: z.uuid(),
  status: z.enum(['starting', 'running', 'stopping', 'stopped', 'expired', 'failed']),
  heldMicro: z.number().int().nonnegative(),
  spentMicro: z.number().int().nonnegative().nullable(),
  startedAt: z.iso.datetime().nullable(),
  deadlineAt: z.iso.datetime(),
  error: z.string().nullable(),
});
export type PreviewSessionBody = z.infer<typeof PreviewSessionBody>;

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
