// 在用户电脑上干活：桌面版主动连上 Oasis（GET /api/harness/v1/devices/connect，WebSocket，带登录 Cookie，
// gateway 认人后转给 harness），harness 把一轮交给它：在用户选的项目文件夹里起 dsh，转发 dsh 的输入输出，
// 读写平台放的文件。消息都是 JSON 文本帧；文件是 tar 包的 base64（和 Docker 取出的格式一样：条目以被取
// 目录的名字开头）。
import { z } from 'zod';

/**
 * 路径和环境变量里地方相关的部分，由桌面版换成实际的：项目文件夹、这个会话的 dsh 家目录（桌面版自己的
 * 数据目录里，按会话分开）、网页地址（dsh 调模型和工具经这个地址上的 gateway）。
 */
export const DEVICE_ROOTS = { project: '{project}', home: '{home}', origin: '{origin}' } as const;

/** 和 dsh 版本一致（沙箱镜像里装的也是这个），桌面版第一次在电脑上干活时装这一版 */
export const DSH_VERSION = '0.2.1-rc.5';

const RunId = z.uuid();
/** 设备号、会话号：只用字母数字和 - _ */
const Name = z.string().regex(/^[\w-]{1,64}$/);

/** harness → 桌面版 */
export const HarnessMessage = z.discriminatedUnion('type', [
  /** 起 dsh：先把文件放好（dir 带 {project} 或 {home}），再按 env 起进程；起好了回 reply */
  z.object({
    type: z.literal('start'),
    id: z.string(),
    runId: RunId,
    folder: z.string().min(1).max(1000),
    workspaceId: Name,
    env: z.record(z.string(), z.string()),
    files: z.array(z.object({ dir: z.string(), tar: z.string() })),
  }),
  /** 交给 dsh 的标准输入（JSON-RPC 的一行或几行） */
  z.object({ type: z.literal('stdin'), runId: RunId, data: z.string() }),
  /** 结束 dsh（停下、取消、收尾） */
  z.object({ type: z.literal('stop'), runId: RunId }),
  /** 把一个目录或文件打成 tar 取回来（reply.data；不存在时 ok 为 false、没有 data） */
  z.object({
    type: z.literal('read'),
    id: z.string(),
    folder: z.string().min(1).max(1000),
    workspaceId: Name,
    path: z.string().min(1).max(2000),
  }),
  /**
   * 列出一个目录里的文件（reply.data 是 JSON：[{ path, size, sha256 }]，path 相对这个目录；目录不在时是空的）。
   * 一轮结束时列 out/：平台只记清单，文件留在电脑上，画布要哪个再取哪个
   */
  z.object({
    type: z.literal('list'),
    id: z.string(),
    folder: z.string().min(1).max(1000),
    workspaceId: Name,
    path: z.string().min(1).max(2000),
  }),
  /** 这个会话的 dsh 记录还在不在（接着原会话做之前问） */
  z.object({ type: z.literal('exists'), id: z.string(), workspaceId: Name }),
  /** 删掉这个会话的 dsh 家目录（删对话、开新话题） */
  z.object({ type: z.literal('purge'), id: z.string(), workspaceId: Name }),
]);
export type HarnessMessage = z.infer<typeof HarnessMessage>;

/** 桌面版 → harness */
export const DeviceMessage = z.discriminatedUnion('type', [
  /** 一连上先报：这台电脑叫什么、什么系统、能不能跑（没装 Node 这类问题写在 problem 里） */
  z.object({
    type: z.literal('hello'),
    name: z.string().max(200),
    platform: z.string().max(50),
    problem: z.string().max(2000).nullable(),
  }),
  z.object({ type: z.literal('stdout'), runId: RunId, data: z.string() }),
  z.object({ type: z.literal('stderr'), runId: RunId, data: z.string() }),
  /** dsh 退出了（code 为 null 是被结束的） */
  z.object({ type: z.literal('exit'), runId: RunId, code: z.number().int().nullable() }),
  /** 准备中的进展（第一次装 dsh 要几分钟），harness 记进这一轮的进度 */
  z.object({ type: z.literal('progress'), runId: RunId, status: z.string().max(100) }),
  /** 对 start、read、list、exists、purge 的回答 */
  z.object({
    type: z.literal('reply'),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().max(4000).optional(),
    data: z.string().optional(),
  }),
]);
export type DeviceMessage = z.infer<typeof DeviceMessage>;
