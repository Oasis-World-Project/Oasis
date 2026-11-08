// 检查用的算力（ADR 0024）：inspector 不调别的服务，开检查容器的算力由关卡先在 model-gateway 冻结，
// 再按 inspector 报回的实际用量结算，记在这个任务和节点上（和节点运行的沙箱同一套计量）。
// 检查没做完不收钱；结算没成功时冻结到期自动退回，不会多扣。
import { randomUUID } from 'node:crypto';
import type { ComputeUsage } from '@oasis/contracts/inspector';
import { ComputeHold, type ComputeHoldBody } from '@oasis/contracts/model-gateway';
import type { Logger, ServiceClient } from '@oasis/service-kit';

/** 这次检查付多少算力：几核、最多跑多久（也是冻结的依据） */
export interface CheckGrant {
  purpose: Exclude<ComputeHoldBody['purpose'], 'run'>;
  cores: number;
  maxMs: number;
}

/** 谁付钱、记在哪个任务和节点上 */
interface Payer {
  payerId: string;
  taskId: string;
  nodeId: string;
}

export function createCheckCompute(deps: { modelGateway: ServiceClient; logger: Logger }) {
  const { modelGateway, logger } = deps;
  return async function metered<T extends { usage: ComputeUsage }>(
    payer: Payer,
    grant: CheckGrant,
    work: () => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    const hold = await modelGateway.json('POST', '/internal/v1/compute', {
      body: {
        runId: id,
        payerId: payer.payerId,
        taskId: payer.taskId,
        nodeId: payer.nodeId,
        cores: grant.cores,
        maxMs: grant.maxMs,
        purpose: grant.purpose,
      },
      schema: ComputeHold,
      requestId: id,
    });
    let usage: ComputeUsage = { cores: grant.cores, elapsedMs: 0 };
    try {
      const result = await work();
      usage = {
        cores: result.usage.cores,
        elapsedMs: Math.min(grant.maxMs, result.usage.elapsedMs),
      };
      return result;
    } finally {
      if (hold.callId)
        await modelGateway
          .json('POST', `/internal/v1/compute/${hold.callId}/settle`, {
            body: usage,
            requestId: id,
          })
          .catch((err: unknown) =>
            logger.warn({ err, callId: hold.callId }, '检查算力没结算上，冻结到期会自动退回'),
          );
    }
  };
}

export type CheckCompute = ReturnType<typeof createCheckCompute>;
