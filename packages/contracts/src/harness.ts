// harness 的内部接口（gateway 不转发）：conversation 用它开一轮、看进度、插话、停止、取消。
// 一轮 = 一次运行：对话里的主 AI 在沙箱里接着同一个会话（同一个持久工作目录）干活。
import { z } from 'zod';

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
  /** 用户点了停止：已经做出来的产出存下了，会话在持久工作目录里，下一轮接着 */
  'stopped',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * 一轮在哪干活：云端沙箱（默认），或用户自己的电脑——桌面版连着 Oasis，在用户选的项目文件夹里跑。
 * 换地方就接不上原来的会话（AI 的记忆在原来那边），所以私聊换地方时从新话题开始。
 */
export const Workplace = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud') }),
  z.object({
    kind: z.literal('device'),
    /** 桌面版的设备号（第一次打开时生成，存在那台电脑上） */
    deviceId: z.string().regex(/^[\w-]{8,64}$/),
    /** 项目文件夹在那台电脑上的完整路径 */
    folder: z.string().min(1).max(1000),
  }),
]);
export type Workplace = z.infer<typeof Workplace>;

/**
 * 权限两档，只在用户电脑上分（云端沙箱本来就隔离，什么都不问）：
 * 手动（manual）读、改项目文件夹里的文件不问；要做出文件夹的事、要用生图视频这类花钱的工具，先在聊天里出
 * 确认卡问用户。自动（auto）都不问，出文件夹的事也能做。
 * always：手动档里用户在确认卡上点过「以后都允许」的那一类（command 出文件夹的事，tool 花钱的工具），之后不再问。
 * web 联网搜索和读网页这两个工具给不给用：没写就是开，用户在输入框里关掉后是 false（下一轮起生效）。
 */
export const Permissions = z.object({
  mode: z.enum(['manual', 'auto']),
  always: z
    .array(z.enum(['command', 'tool']))
    .max(2)
    .optional(),
  web: z.boolean().optional(),
});
export type Permissions = z.infer<typeof Permissions>;

/** 默认：用户电脑上手动，云端自动 */
export const defaultPermissions = (workplace: Workplace): Permissions => ({
  mode: workplace.kind === 'device' ? 'manual' : 'auto',
});

/** 这一轮里这一类事要不要先问用户：只有用户电脑上的手动档问，点过「以后都允许」的那一类不问 */
export const asksBefore = (
  kind: 'command' | 'tool',
  workplace: Workplace,
  permissions: Permissions,
): boolean =>
  workplace.kind === 'device' &&
  permissions.mode === 'manual' &&
  !permissions.always?.includes(kind);

/** 交给 AI 的文件放在沙箱的哪里：只能在 materials/ 下，不能有 .. */
const MaterialPath = z
  .string()
  .min(1)
  .max(600)
  .regex(/^materials\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\n]+$/, '必须放在 materials/ 下，不能有 ..');

const Materials = z
  .array(
    z.union([
      z.object({ uploadId: z.uuid(), path: MaterialPath, ownerId: z.uuid().optional() }),
      z.object({ artifactId: z.uuid(), path: MaterialPath, ownerId: z.uuid().optional() }),
    ]),
  )
  .max(2000);

export const StartRunBody = z.object({
  /** 调用方可以自带运行 ID（便于幂等）；不给就由 harness 生成 */
  runId: z.uuid().optional(),
  /** 花哪个账户的钱：个人的账户号是用户 ID，群的金库是群的 ID */
  payerId: z.uuid(),
  /** 这一轮替谁做的（他的电脑、他名下的文件；花金库的钱时记在他头上）：不给就是付钱的那个人自己 */
  actorId: z.uuid().optional(),
  /** 这一轮属于哪个对话：删对话时一起清理 */
  conversationId: z.uuid(),
  /** 供应商型号，如 deepseek/deepseek-v4.1-flash */
  model: z.string().min(1).max(200),
  /** 这个 AI 是谁（人设），写进沙箱里给 AI 的说明 */
  persona: z.string().max(20_000).default(''),
  /**
   * 这一轮在什么场合：私聊（一对一），还是群里（几个人和几个 AI；说明开头换成群里的那一节，
   * 群里有谁、各自负责什么写在 persona 里）
   */
  scene: z.enum(['dm', 'group']).default('dm'),
  /** 用户打开了「只用国内模型」：国外厂商的型号不能开这一轮，这一轮的工具也只给国内厂商的型号 */
  domesticOnly: z.boolean().default(false),
  /** 用户这一轮说的话 */
  prompt: z.string().min(1).max(200_000),
  /**
   * 交给 AI 的文件：开沙箱前由 harness 向 canvas 取出，放在沙箱里的 path（如 materials/照片.jpg）。
   * uploadId 是用户随消息发的文件；artifactId 是画布里的成果（「让 AI 改」的成果不在这个会话的
   * 工作目录里时拷一份进来）。是不是这个用户的，conversation 收消息时已经核对过。
   * ownerId：这个文件在 canvas 里是谁名下的；不给就是这一轮替谁做的那个人（群里的文件都要给）。
   */
  materials: Materials.default([]),
  /**
   * 接着上一轮做：挂上它的持久工作目录（会话、out/、装好的依赖都在），AI 记得前面的事。
   * 只能接同一个对话里已结束、工作目录还在的运行；工作目录不在了返回 409 {@link WORKSPACE_UNAVAILABLE}。
   */
  continueFrom: z.uuid().optional(),
  /** 在哪干活：不给就是云端沙箱 */
  workplace: Workplace.default({ kind: 'cloud' }),
  /** 这一轮的权限：不给按在哪干活的默认（{@link defaultPermissions}） */
  permissions: Permissions.optional(),
});
export type StartRunBody = z.input<typeof StartRunBody>;

/** 这一轮要在用户电脑上跑，但那台电脑的桌面版现在没连上 Oasis */
export const DEVICE_OFFLINE = 'device_offline';

/** 接着的那一轮的持久工作目录已经不在了（被清掉）：接不上原会话，调用方改成开新会话。 */
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
  conversationId: z.uuid(),
  /** 这一轮所在的会话（话题）：接着上一轮做的同属一个会话，开新话题就是新的会话 */
  sessionId: z.uuid(),
  model: z.string(),
  status: RunStatus,
  /** 持久工作目录还在，下一轮可以用 continueFrom 接着这个会话 */
  resumable: z.boolean().optional(),
  error: z.string().nullable(),
  outputs: z.array(RunOutputFile),
  /** AI 最后说的一段话 */
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RunBody = z.infer<typeof RunBody>;

/**
 * 运行过程中的事件（已从 dsh 的原始事件翻译过来，调用方不需要认识 dsh）。
 * - status：运行时整体变为忙 / 空闲、服务中断后恢复
 * - user_message：用户的话（开头那句和插话；插话带 interjection: true，在 AI 看到它时出现）
 * - assistant_text：AI 说的话（一步一段）
 * - tool_call / tool_result：AI 调用工具及结果（内容过长会截断；tool_call 带给人看的一句话 label）
 * - todos：AI 列的待办（{ items: [{ text, status: pending | doing | done }] }）
 * - turn_end：一轮结束及原因
 * - error：运行出错
 * 子任务（AI 派出去的子代理）的事件带 parentSessionId。
 */
export const RunEventKind = z.enum([
  'status',
  'user_message',
  'assistant_text',
  'tool_call',
  'tool_result',
  'todos',
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

/** 用户在这一轮进行中插话：在 AI 的下一步送到，带着完整上下文 */
export const RunMessageBody = z.object({ text: z.string().trim().min(1).max(20_000) });
/** 一轮进行中往它的工作目录里再放文件（群里别的 AI 刚交的群文件）；这一轮已经不在跑时 409 */
export const RunMaterialsBody = z.object({ materials: Materials.min(1) });
