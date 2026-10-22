// 所有服务共用的响应契约：统一错误体和探针响应。
import { z } from 'zod';

/** 统一错误响应。code 给程序判断用（如 not_found），message 给人看。 */
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** GET /health：进程存活。 */
export const HealthBody = z.object({ status: z.literal('ok') });
export type HealthBody = z.infer<typeof HealthBody>;

/** GET /ready：依赖全部可用才是 ready，checks 列出每项依赖的结果。 */
export const ReadyBody = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), z.enum(['ok', 'failed'])),
});
export type ReadyBody = z.infer<typeof ReadyBody>;

/** GET /v1/meta：当前运行的是哪个服务、哪个版本。 */
export const MetaBody = z.object({
  service: z.string(),
  version: z.string(),
  commit: z.string(),
});
export type MetaBody = z.infer<typeof MetaBody>;

/**
 * 服务之间约定的请求头。x-oasis-* 只能由内部写入：gateway 会丢弃客户端带来的同名头。
 * - userId：gateway 校验会话后写入的当前用户
 * - payerId：模型调用由谁付费（私聊是主人，群聊是群主）
 * - taskId / nodeId：内部服务替某个任务的某个节点调用模型时写明归属（计入任务花费）
 */
export const OASIS_HEADERS = {
  userId: 'x-oasis-user-id',
  payerId: 'x-oasis-payer-id',
  taskId: 'x-oasis-task-id',
  nodeId: 'x-oasis-node-id',
  requestId: 'x-request-id',
} as const;
