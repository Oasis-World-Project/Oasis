// 每一次上游调用（聊天、决策）共用的计量步骤：冻结额度并登记 → 按实际花费结算，或失败退回。
import { randomUUID } from 'node:crypto';
import { HoldResult, SettleResult } from '@oasis/contracts/billing';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import type { CallKind, CallsRepo } from '../repo/calls-repo.ts';
import type { CostSource, Usage } from './pricing.ts';

/** 谁在调用、钱算在哪：付费人，以及（agent 运行时）所属的任务、节点和运行。 */
export interface Caller {
  payerId: string;
  runId?: string;
  taskId?: string;
  nodeId?: string;
}

export interface MeteredCall {
  id: string;
  holdId: string;
  requestId: string;
  model: string;
}

export function createMeter(deps: { billing: ServiceClient; repo: CallsRepo; logger: Logger }) {
  const { billing, repo, logger } = deps;
  return {
    /** 冻结额度并登记调用。额度不够时 billing 返回 402，调用方应直接把错误交出去、不调上游。 */
    async hold(input: {
      caller: Caller;
      kind: CallKind;
      model: string;
      amountMicro: number;
      requestId: string;
    }): Promise<MeteredCall> {
      const id = randomUUID();
      const { holdId } = await billing.json('POST', '/internal/holds', {
        body: {
          userId: input.caller.payerId,
          amountMicro: input.amountMicro,
          reason: 'model_call',
          ref: `call:${id}`,
        },
        requestId: input.requestId,
        schema: HoldResult,
      });
      await repo.start({
        id,
        kind: input.kind,
        payerId: input.caller.payerId,
        runId: input.caller.runId ?? null,
        taskId: input.caller.taskId ?? null,
        nodeId: input.caller.nodeId ?? null,
        model: input.model,
        requestId: input.requestId,
        holdId,
      });
      return { id, holdId, requestId: input.requestId, model: input.model };
    },

    /** 上游没产生费用就失败了：退回冻结。退回失败也不要紧，冻结过期后会被自动回收。 */
    async release(call: MeteredCall, error: string): Promise<void> {
      await billing
        .json('POST', `/internal/holds/${call.holdId}/release`, {
          body: {},
          requestId: call.requestId,
        })
        .catch((err: unknown) =>
          logger.error({ err, holdId: call.holdId }, '退回冻结失败，等待过期自动回收'),
        );
      await repo.finish(call.id, { status: 'failed', error, chargedMicro: 0 });
    },

    /** 按实际花费结算（多冻结的部分退回），并记下用量和花费来源。 */
    async settle(
      call: MeteredCall,
      cost: { costMicro: number; source: CostSource },
      usage: Usage | undefined,
      error?: string,
    ): Promise<void> {
      let chargedMicro: number | null = null;
      try {
        ({ chargedMicro } = await billing.json('POST', `/internal/holds/${call.holdId}/settle`, {
          body: {
            costMicro: cost.costMicro,
            detail: { model: call.model, callId: call.id, costSource: cost.source },
          },
          requestId: call.requestId,
          schema: SettleResult,
        }));
      } catch (err) {
        logger.error(
          { err, holdId: call.holdId, costMicro: cost.costMicro },
          '结算失败，冻结将过期退回',
        );
      }
      await repo.finish(call.id, {
        status: error ? 'failed' : 'succeeded',
        error: error ?? null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        upstreamCostMicro: cost.costMicro,
        chargedMicro,
        costSource: cost.source,
      });
    },
  };
}

export type Meter = ReturnType<typeof createMeter>;
