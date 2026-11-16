// 任务卡和成果：这一轮用了生图、视频这类工具或交了文件就是一个任务，出任务卡（任务名、状态、花费、
// 成果）。做好的文件一个个登记进画布（做好一个进一个），写到任务卡上；结束时按产出清单再登记一遍。
import { isDeepStrictEqual } from 'node:util';
import { ArtifactBody, type RegisterRunArtifactsBody } from '@oasis/contracts/canvas';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { TaskCard, TaskFile } from '@oasis/contracts/conversation';
import type { RunBody } from '@oasis/contracts/harness';
import { GENERATION_TOOLS, RunActivity } from '@oasis/contracts/model-gateway';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import { roomOf, type Conversation, type ConversationRepo } from '../repo/conversation-repo.ts';
import type { Turn } from '../repo/schema.ts';

const RegisteredArtifacts = z.object({ artifacts: z.array(ArtifactBody) });

export function createTaskCards(deps: {
  canvas: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  /** 群里的席位交了文件（已登记进画布）：进群文件 */
  delivered?: (seat: Conversation, runId: string, files: ArtifactBody[]) => Promise<void>;
}) {
  const { logger } = deps;

  /** 这一轮在 model-gateway 那边的情况：花费、用过的工具、在等用户点的确认卡 */
  const activityOf = (ownerId: string, runId: string) =>
    deps.modelGateway.json('GET', `/internal/v1/runs/${runId}`, {
      headers: { [OASIS_HEADERS.payerId]: ownerId },
      schema: RunActivity,
    });

  /** 任务卡：有就更新，没有就建 */
  async function save(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    card: TaskCard,
  ) {
    const content = card.status === 'running' ? '任务进行中' : '任务结束';
    if (turn.cardId && (await store.updateMessage(turn.cardId, { content, data: card }))) return;
    const created = await store.insertMessage({
      conversationId: roomOf(conversation),
      authorKind: 'ai',
      authorId: conversation.modelKey ?? 'unknown',
      content,
      status: 'complete',
      kind: 'task',
      data: card,
    });
    await store.updateTurn(conversation.id, turn.runId, { cardId: created.id });
    turn.cardId = created.id;
  }

  /** 这一轮 out/ 里的文件登记进画布（任务名给电脑上的文件夹起名），返回这一轮的全部成果 */
  async function register(
    conversation: Conversation,
    turn: Turn,
    run: Pick<RunBody, 'id' | 'sessionId' | 'model'>,
    outputs: RegisterRunArtifactsBody['outputs'],
  ): Promise<TaskFile[]> {
    const { artifacts } = await deps.canvas.json('POST', '/internal/artifacts/runs', {
      body: {
        ownerId: conversation.ownerId,
        conversationId: conversation.id,
        sessionId: run.sessionId,
        runId: run.id,
        task: turn.title ?? conversation.title,
        models: [run.model],
        outputs,
      },
      schema: RegisteredArtifacts,
    });
    if (conversation.kind === 'seat') await deps.delivered?.(conversation, run.id, artifacts);
    return artifacts.map((a) => ({
      artifactId: a.id,
      name: a.name,
      path: a.path,
      size: a.size,
      category: a.category,
    }));
  }

  /**
   * 做好了的文件登记进画布：一个读不到（挪走了、删掉了）不挡别的，登记不上的不再试（结束时按产出清单
   * 再登记一遍）。登记过的从这一轮里划掉；返回这一轮的全部成果
   */
  async function deliver(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    run: RunBody,
  ): Promise<TaskFile[]> {
    const paths = turn.delivering ?? [];
    let files = turn.files ?? [];
    if (!paths.length) return files;
    const outputs = paths.map((path) => ({ path: path.slice('out/'.length) }));
    try {
      files = await register(conversation, turn, run, outputs);
    } catch {
      for (const output of outputs) {
        try {
          files = await register(conversation, turn, run, [output]);
        } catch (err) {
          logger.warn(
            { err, runId: turn.runId, path: output.path },
            '做好的文件没能登记进画布，结束时再登记',
          );
        }
      }
    }
    await store.withLock('message', conversation.id, async (locked) => {
      const latest = (await locked.find(conversation.id))?.turn;
      if (latest?.runId !== turn.runId) return;
      await locked.updateTurn(conversation.id, turn.runId, {
        delivering: (latest.delivering ?? []).filter((path) => !paths.includes(path)),
        files,
      });
    });
    return files;
  }

  /**
   * 进行中看一眼：在等用户点的确认卡放进这一轮（网页上出卡片）；做好的文件登记进画布；用了做东西的
   * 工具或交了文件就出任务卡，花费和成果跟着更新
   */
  async function live(
    store: ConversationRepo,
    conversation: Conversation,
    turn: Turn,
    run: RunBody,
  ) {
    const spend = await activityOf(conversation.ownerId, turn.runId);
    if (!isDeepStrictEqual(spend.confirmations, turn.confirmations ?? []))
      await store.updateTurn(conversation.id, turn.runId, { confirmations: spend.confirmations });
    const files = await deliver(store, conversation, turn, run);
    if (
      !turn.cardId &&
      !files.length &&
      !spend.tools.some((tool) => GENERATION_TOOLS.includes(tool))
    )
      return;
    await save(store, conversation, turn, {
      runId: turn.runId,
      ...(turn.title ? { title: turn.title } : {}),
      status: 'running',
      startedAt: turn.startedAt,
      finishedAt: null,
      spentMicro: spend.spentMicro,
      files,
    });
  }

  return { activityOf, save, register, live };
}
