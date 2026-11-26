// 真删除一段对话在别的服务里的东西：先取消正在进行的一轮并等它收尾，再清 harness 的运行记录和
// 持久工作目录，model-gateway 的工具结果，画布里的成果。删私聊、群里移出 AI、解散群都用它。
import { setTimeout as sleep } from 'node:timers/promises';
import { RunBody } from '@oasis/contracts/harness';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import type { Conversation } from '../repo/conversation-repo.ts';

/** 删之前等被取消的那一轮收尾，最多等这么久 */
const CANCEL_WAIT_MS = 60_000;

export function createPurge(deps: {
  harness: ServiceClient;
  modelGateway: ServiceClient;
  canvas: ServiceClient;
}) {
  return {
    /** 取消正在进行的一轮，等它收尾（沙箱停掉、产出存好）；没有就什么都不做 */
    async cancelTurn(conversation: Pick<Conversation, 'turn'>) {
      if (!conversation.turn) return;
      const { runId } = conversation.turn;
      await deps.harness
        .json('POST', `/internal/runs/${runId}/cancel`, { body: {} })
        .catch((err: unknown) => {
          if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
        });
      for (const started = Date.now(); Date.now() - started < CANCEL_WAIT_MS; await sleep(500)) {
        const run = await deps.harness
          .json('GET', `/internal/runs/${runId}`, { schema: RunBody })
          .catch((err: unknown) => {
            if (err instanceof HttpError && err.statusCode === 404) return undefined;
            throw err;
          });
        if (!run || !['queued', 'starting', 'running'].includes(run.status)) return;
      }
      throw new HttpError(409, 'turn_active', '这一轮还在收尾，请稍后再删');
    },

    /**
     * 清掉这段对话（私聊，或群里的一个席位）在 harness、model-gateway、画布里的东西；都可以重复调用。
     * keepArtifacts：画布里的成果留着（群里移出一个 AI，它交过的文件还是群的）。
     */
    async remote(id: string, ownerId: string, requestId: string, keepArtifacts = false) {
      await deps.harness.json('POST', `/internal/conversations/${id}/purge`, {
        body: {},
        requestId,
      });
      await deps.modelGateway.json('POST', `/internal/conversations/${id}/purge`, {
        body: {},
        requestId,
      });
      if (!keepArtifacts)
        await deps.canvas.json('POST', `/internal/conversations/${id}/purge`, {
          body: { ownerId },
          requestId,
        });
    },
  };
}

export type Purge = ReturnType<typeof createPurge>;
