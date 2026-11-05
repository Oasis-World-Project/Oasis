// 每一次上游调用（聊天、决策）共用的计量步骤：冻结额度并登记 → 按实际花费结算，或失败退回。
// 属于某个任务的调用结算后，经发件箱发出 model-gateway.call.settled，task 据此累加花费。
import { randomUUID } from 'node:crypto';
import { HoldResult, SettleResult } from '@oasis/contracts/billing';
import { CallSettled } from '@oasis/contracts/events';
import { createEnvelope, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { REGION_ERROR, type CallKind, type CallsRepo } from '../repo/calls-repo.ts';
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
  if (status === 403 && detail.toLowerCase().includes(REGION_ERROR)) {
    return new HttpError(502, 'provider_region_unavailable', '这个模型在当前网络所在的地区用不了');
  }
  if (status === 429) {
    return new HttpError(503, 'provider_busy', '模型服务现在太忙，请稍后再试');
  }
  return new HttpError(502, 'provider_error', '模型服务返回了错误，请稍后再试');
}

/** 连接还没建立就失败的错误码：请求根本没发出去，等网络恢复后原样重发不会重复扣费或重复执行 */
const NOT_CONNECTED = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
]);

/** 这个错误是不是「连不上」（沿 cause 和多地址尝试的 errors 往下找） */
export function notConnected(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 6) return false;
  const { code, name, cause, errors } = err as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (name === 'AbortError') return false;
  if ((typeof code === 'string' && NOT_CONNECTED.has(code)) || name === 'ConnectTimeoutError')
    return true;
  if (Array.isArray(errors) && errors.some((e) => notConnected(e, depth + 1))) return true;
  return notConnected(cause, depth + 1);
}

export function createMeter(deps: {
  billing: ServiceClient;
  repo: CallsRepo;
  logger: Logger;
  /**
   * 网络短暂断开时最多等多久（2026-11-05 用户决定：任务只因用户停止或网络长时间连不上而停）。
   * 只对请求没发出去的「连不上」生效；超过这么久仍连不上才报错，节点停下等用户点继续。
   */
  reconnectMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { billing, repo, logger } = deps;
  const reconnectMs = deps.reconnectMs ?? 10 * 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

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
    async renew(call: MeteredCall) {
      await billing.json('POST', `/internal/holds/${call.holdId}/renew`, {
        body: { ttlMs: 6 * 3600000 },
        requestId: call.requestId,
      });
    },
    /** 在当前网络用不了的模型：最近一次聊天调用因为地区限制被上游拒绝、之后没再成功过 */
    regionBlockedModels: () => repo.regionBlockedModels(),
    /** 从调用记录算出的典型用量，估价用 */
    typicalUsage: () => repo.typicalUsage(),

    /** 没产生费用就失败了（如长任务在供应商那边失败）：退回冻结，记下原因 */
    fail: release,

    /** 冻结额度并登记调用。额度不够时 billing 返回 402，调用方应直接把错误交出去、不调上游。 */
    async hold(input: {
      caller: Caller;
      kind: CallKind;
      model: string;
      amountMicro: number;
      maxCostMicro?: number;
      requestId: string;
      /** 冻结多久没结算就自动退回（长任务要更久）；不给用 billing 的默认 */
      ttlMs?: number;
    }): Promise<MeteredCall> {
      if (input.maxCostMicro !== undefined && input.amountMicro > input.maxCostMicro) {
        throw new HttpError(
          400,
          'call_budget_exceeded',
          '本次预计冻结金额超过单次预算，未调用供应商',
        );
      }
      const id = randomUUID();
      const { holdId } = await billing.json('POST', '/internal/holds', {
        body: {
          userId: input.caller.payerId,
          amountMicro: input.amountMicro,
          reason: 'model_call',
          ref: `call:${id}`,
          ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
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

    /**
     * 调上游。网络短暂断开（请求没发出去）时等网络恢复后原样重发同一请求，调用方只是多等一会儿；
     * 长时间连不上、或还没产生费用就被拒绝时退回冻结，并抛出给调用方看的错误。
     */
    async callUpstream(call: MeteredCall, request: () => Promise<Response>): Promise<Response> {
      let response: Response;
      const started = Date.now();
      for (let attempt = 1; ; attempt += 1) {
        try {
          response = await request();
          break;
        } catch (err) {
          const waitedMs = Date.now() - started;
          if (notConnected(err) && waitedMs < reconnectMs) {
            const delayMs = Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4));
            logger.warn(
              { err, model: call.model, attempt, waitedMs, delayMs },
              '连不上模型服务商：请求没发出去，等网络恢复后重发同一请求',
            );
            await sleep(delayMs);
            continue;
          }
          await release(call, `上游连接失败：${String(err)}`);
          throw new HttpError(503, 'provider_unavailable', '模型服务暂时连不上', { cause: err });
        }
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
    ): Promise<boolean> {
      const previous = await repo.get(call.id);
      if (previous?.chargedMicro !== null && previous?.chargedMicro !== undefined)
        return previous.upstreamCostMicro === cost.costMicro;
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
      return chargedMicro !== null;
    },
  };
}

export type Meter = ReturnType<typeof createMeter>;
