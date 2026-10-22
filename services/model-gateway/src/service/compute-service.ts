// 算力计费（ADR 0006 §6）：harness 开沙箱前按最长运行时间冻结，沙箱销毁后按实际时长 × 核数 × 单价结算。
// 和模型、工具共用一套计量（冻结、结算、调用记录、属于任务的发 model-gateway.call.settled）。
import { HttpError } from '@oasis/service-kit';
import type { CallsRepo } from '../repo/calls-repo.ts';
import type { Meter } from './metering.ts';

const HOUR_MS = 3_600_000;
/** 冻结比最长运行时间多留这么久，免得结算前就被自动退回 */
const HOLD_MARGIN_MS = 10 * 60_000;
/** 调用记录里的「模型」一栏 */
const COMPUTE_MODEL = 'sandbox';

export function createComputeService(deps: {
  meter: Meter;
  repo: CallsRepo;
  /** 每核每小时多少钱（微美元）；为 0 时不计费 */
  pricePerCoreHourMicro: number;
}) {
  const { meter, repo } = deps;
  const cost = (cores: number, ms: number) =>
    Math.ceil((cores * ms * deps.pricePerCoreHourMicro) / HOUR_MS);

  return {
    async hold(input: {
      runId: string;
      payerId: string;
      taskId: string | null;
      nodeId: string | null;
      cores: number;
      maxMs: number;
      requestId: string;
    }): Promise<{ callId: string | null }> {
      if (deps.pricePerCoreHourMicro === 0) return { callId: null };
      const call = await meter.hold({
        caller: {
          payerId: input.payerId,
          runId: input.runId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        },
        kind: 'compute',
        model: COMPUTE_MODEL,
        amountMicro: Math.max(1, cost(input.cores, input.maxMs)),
        requestId: input.requestId,
        ttlMs: input.maxMs + HOLD_MARGIN_MS,
      });
      return { callId: call.id };
    },

    /** 按实际时长结算；已经结算过的不再结算 */
    async settle(callId: string, input: { cores: number; elapsedMs: number }): Promise<void> {
      const row = await repo.get(callId);
      if (row?.kind !== 'compute' || !row.holdId) {
        throw new HttpError(404, 'call_not_found', '没有这次算力冻结');
      }
      if (row.status !== 'running') return;
      await meter.settle(
        {
          id: row.id,
          holdId: row.holdId,
          requestId: row.requestId ?? callId,
          model: row.model,
          kind: 'compute',
          caller: {
            payerId: row.payerId,
            ...(row.runId ? { runId: row.runId } : {}),
            ...(row.taskId ? { taskId: row.taskId } : {}),
            ...(row.nodeId ? { nodeId: row.nodeId } : {}),
          },
        },
        { costMicro: cost(input.cores, input.elapsedMs), source: 'estimate' },
        undefined,
      );
    },
  };
}

export type ComputeService = ReturnType<typeof createComputeService>;
