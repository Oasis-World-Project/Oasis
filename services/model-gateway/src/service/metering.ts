// 每一次上游调用（聊天、决策）共用的计量步骤：冻结额度并登记 → 按实际花费结算，或失败退回。
// 属于某个任务的调用结算后，经发件箱发出 model-gateway.call.settled，task 据此累加花费。
import { randomUUID } from 'node:crypto';
import { HoldResult, SettleResult } from '@oasis/contracts/billing';
import { CallSettled } from '@oasis/contracts/events';
import { createEnvelope, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
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
  kind: CallKind;
  caller: Caller;
}

/** 把上游拒绝的原因归成几类，让用户看到能照着做的提示；细节只进日志和调用记录。 */
function upstreamError(status: number, detail: string): HttpError {
  if (status === 403 && /not available in your region/i.test(detail)) {
    return new HttpError(502, 'provider_region_unavailable', '这个模型在当前网络所在的地区用不了');
  }
  if (status === 429) {
    return new HttpError(503, 'provider_busy', '模型服务现在太忙，请稍后再试');
  }
  return new HttpError(502, 'provider_error', '模型服务返回了错误，请稍后再试');
}

export function createMeter(deps: { billing: ServiceClient; repo: CallsRepo; logger: Logger }) {
  const { billing, repo, logger } = deps;

  async function release(call: MeteredCall, error: string): Promise<void> {
    await billing
      .json('POST', `/internal/holds/${call.holdId}/release`, {
        body: {},
        requestId: call.requestId,
      })
      .catch((err: unknown) =>
        logger.error({ err, holdId: call.holdId }, '退回冻结失败，等待过期自动回收'),
      );
    await repo.finish(call.id, { status: 'failed', error, chargedMicro: 0 });
  }

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
      return {
        id,
        holdId,
        requestId: input.requestId,
        model: input.model,
        kind: input.kind,
        caller: input.caller,
      };
    },

    /** 调上游。还没产生费用就失败（连不上、被拒绝）时退回冻结，并抛出给调用方看的错误。 */
    async callUpstream(call: MeteredCall, request: () => Promise<Response>): Promise<Response> {
      let response: Response;
      try {
        response = await request();
      } catch (err) {
        await release(call, `上游连接失败：${String(err)}`);
        throw new HttpError(503, 'provider_unavailable', '模型服务暂时连不上', { cause: err });
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        await release(call, `上游返回 ${response.status}：${detail}`);
        logger.warn({ status: response.status, detail, model: call.model }, '上游拒绝了请求');
        throw upstreamError(response.status, detail);
      }
      return response;
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
      const { caller } = call;
      const settled =
        caller.taskId && chargedMicro !== null
          ? createEnvelope('model-gateway', CallSettled.type, {
              callId: call.id,
              payerId: caller.payerId,
              taskId: caller.taskId,
              nodeId: caller.nodeId ?? null,
              runId: caller.runId ?? null,
              kind: call.kind,
              model: call.model,
              chargedMicro,
              settledAt: new Date().toISOString(),
            })
          : undefined;
      await repo.finish(
        call.id,
        {
          status: error ? 'failed' : 'succeeded',
          error: error ?? null,
          promptTokens: usage?.prompt_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? null,
          upstreamCostMicro: cost.costMicro,
          chargedMicro,
          costSource: cost.source,
        },
        settled,
      );
    },
  };
}

export type Meter = ReturnType<typeof createMeter>;
