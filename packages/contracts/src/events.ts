// 服务之间的异步事件。主题名就是事件类型，形如 <服务>.<对象>.<动作>。
import { z } from 'zod';

/** 所有事件共用的信封（参照 CloudEvents 精简）。id 同时用作 JetStream 去重 ID。 */
export const EventEnvelope = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  source: z.string().min(1),
  time: z.iso.datetime(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** identity 的事件都在这个 stream 里。 */
export const IDENTITY_STREAM = { name: 'IDENTITY', subjects: ['identity.>'] } as const;

/** 新用户完成邮箱验证、第一次登录。billing 据此赠送注册额度。 */
export const UserRegistered = {
  type: 'identity.user.registered',
  data: z.object({
    userId: z.uuid(),
    registeredAt: z.iso.datetime(),
  }),
} as const;
export type UserRegisteredData = z.infer<typeof UserRegistered.data>;

/** harness 的事件都在这个 stream 里。 */
export const HARNESS_STREAM = { name: 'HARNESS', subjects: ['harness.>'] } as const;

const RunRef = {
  runId: z.uuid(),
  payerId: z.uuid(),
  taskId: z.uuid().nullable(),
  nodeId: z.uuid().nullable(),
};

/** agent 运行结束（成功、失败、取消或停止）。task 据此推进节点状态。 */
export const RunFinished = {
  type: 'harness.run.finished',
  data: z.object({
    ...RunRef,
    status: z.enum(['succeeded', 'failed', 'cancelled', 'stopped']),
    error: z.string().nullable(),
    outputs: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
    /** AI 最后说的一句话 */
    summary: z.string().nullable(),
    finishedAt: z.iso.datetime(),
  }),
} as const;
export type RunFinishedData = z.infer<typeof RunFinished.data>;

/** model-gateway 的事件都在这个 stream 里。 */
export const MODEL_GATEWAY_STREAM = {
  name: 'MODEL_GATEWAY',
  subjects: ['model-gateway.>'],
} as const;

/**
 * 一次属于某个任务的模型调用结算完了（聊天、Jev 决策都算）。task 据此累加任务和节点的花费，
 * 超过上限时暂停任务。不属于任务的调用（私聊）不发。
 */
export const CallSettled = {
  type: 'model-gateway.call.settled',
  data: z.object({
    callId: z.uuid(),
    payerId: z.uuid(),
    taskId: z.uuid(),
    nodeId: z.uuid().nullable(),
    runId: z.uuid().nullable(),
    kind: z.enum(['chat', 'decision']),
    model: z.string(),
    /** 实际扣了多少（微美元） */
    chargedMicro: z.number().int().nonnegative(),
    settledAt: z.iso.datetime(),
  }),
} as const;
export type CallSettledData = z.infer<typeof CallSettled.data>;
