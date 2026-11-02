// 续租负责凭证与算力窗口，不负责执行调度，也不定义任务总时长。
import { ComputeHold } from '@oasis/contracts/model-gateway';
import type { ServiceClient } from '@oasis/service-kit';

export async function startRunLease(input: {
  client: ServiceClient;
  runId: string;
  payerId: string;
  taskId: string | null;
  nodeId: string | null;
  keyId: string;
  keyTtlSeconds: number;
  cores: number;
  windowMs: number;
  onFailure: (error: unknown) => void;
}) {
  const { client, runId, cores, windowMs } = input;
  let closed = false;
  let current: { id: string | null; since: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  const unpaid = new Map<string, number>();
  const pay = async (id: string, elapsedMs: number) => {
    await client.json('POST', `/internal/v1/compute/${id}/settle`, {
      body: { cores, elapsedMs },
      requestId: runId,
    });
    unpaid.delete(id);
  };
  const settle = async (lease: NonNullable<typeof current>, end: number) => {
    if (!lease.id) return;
    const elapsedMs = Math.max(0, end - lease.since);
    unpaid.set(lease.id, elapsedMs);
    await pay(lease.id, elapsedMs);
  };
  const reserve = () =>
    client.json('POST', '/internal/v1/compute', {
      body: {
        runId,
        payerId: input.payerId,
        taskId: input.taskId,
        nodeId: input.nodeId,
        cores,
        maxMs: windowMs,
      },
      schema: ComputeHold,
      requestId: runId,
    });
  const first = await reserve();
  current = { id: first.callId, since: Date.now() };
  function schedule() {
    if (closed) return;
    // 提前续租，原冻结仍有效；请求串行，收尾等待在途续租完成。
    const delay = Math.min(windowMs, input.keyTtlSeconds * 1000) / 2;
    timer = setTimeout(() => {
      pending = renew().catch((error: unknown) => {
        if (!closed) input.onFailure(error);
      });
    }, delay);
  }
  async function renew() {
    await client.json('POST', `/internal/run-keys/${input.keyId}/renew`, {
      body: { ttlSeconds: input.keyTtlSeconds },
      requestId: runId,
    });
    if (closed) return;
    const next = await reserve();
    const now = Date.now();
    const previous = current;
    current = { id: next.callId, since: now };
    if (previous) await settle(previous, now);
    schedule();
  }
  schedule();
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      await pending;
      if (current?.id) unpaid.set(current.id, Math.max(0, Date.now() - current.since));
      const results = await Promise.allSettled(
        [...unpaid].map(([id, elapsed]) => pay(id, elapsed)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
