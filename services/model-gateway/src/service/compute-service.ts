// 算力计费（ADR 0006 §6）：harness 开沙箱前按最长运行时间冻结，沙箱销毁后按实际时长 × 核数 × 单价结算。
// 和模型、工具共用一套计量（冻结、结算、调用记录、属于任务的发 model-gateway.call.settled）。
import { HttpError } from '@oasis/service-kit';
import type { CallsRepo } from '../repo/calls-repo.ts';
import type { Meter } from './metering.ts';

const HOUR_MS = 3_600_000;
/** 冻结比最长运行时间多留这么久，免得结算前就被自动退回 */
const HOLD_MARGIN_MS = 10 * 60_000;
/** 调用记录里的「模型」一栏 */

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
    quote(cores: number, maxMs: number) {
      return { maxMicro: cost(cores, maxMs) };
    },
    async hold(input: {
      runId: string;
      payerId: string;
      taskId: string | null;
      nodeId: string | null;
      cores: number;
      maxMs: number;
      purpose?: 'run' | 'preview' | 'application-check';
      requestId: string;
    }): Promise<{ callId: string | null; heldMicro: number }> {
      if (deps.pricePerCoreHourMicro === 0) return { callId: null, heldMicro: 0 };
      const heldMicro = Math.max(1, cost(input.cores, input.maxMs));
      const call = await meter.hold({
        caller: {
          payerId: input.payerId,
          runId: input.runId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        },
        kind: 'compute',
        model:
          input.purpose === 'preview'
            ? 'preview'
            : input.purpose === 'application-check'
              ? 'application-check'
              : 'sandbox',
        amountMicro: heldMicro,
        requestId: input.requestId,
        ttlMs: input.maxMs + HOLD_MARGIN_MS,
      });
      return { callId: call.id, heldMicro };
    },

    /** 按实际时长结算；已经结算过的不再结算 */
    async settle(callId: string, input: { cores: number; elapsedMs: number }): Promise<void> {
      const row = await repo.get(callId);
      if (row?.kind !== 'compute' || !row.holdId) {
        throw new HttpError(404, 'call_not_found', '没有这次算力冻结');
      }
      if (row.chargedMicro !== null) return;
      const paid = await meter.settle(
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
      if (!paid)
        throw new HttpError(503, 'compute_settlement_pending', '算力结算尚未完成，不能继续续租');
    },
    async outcome(callId: string) {
      const row = await repo.get(callId);
      if (row?.kind !== 'compute') throw new HttpError(404, 'call_not_found', '没有这次算力调用');
      return { status: row.status, chargedMicro: row.chargedMicro };
    },
    /** 执行器已停止旧容器后调用；只结算该运行未结清的沙箱算力，不碰供应商长任务。 */
    async recover(runId: string, input: { payerId: string; cores: number; endedAt: string }) {
      const rows = (await repo.computeForRun(runId, input.payerId)).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      for (const [index, row] of rows.entries()) {
        if (row.chargedMicro !== null) continue;
        const end = Math.min(
          new Date(input.endedAt).getTime(),
          rows[index + 1]?.createdAt.getTime() ?? Infinity,
        );
        await this.settle(row.id, {
          cores: input.cores,
          elapsedMs: Math.max(0, end - row.createdAt.getTime()),
        });
      }
    },
  };
}

export type ComputeService = ReturnType<typeof createComputeService>;
