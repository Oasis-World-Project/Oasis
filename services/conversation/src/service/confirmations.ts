// 点确认卡：AI 要做超出权限的事时这一轮停下来等（确认卡记在这一轮上）；允许一次 / 以后都允许 / 拒绝。
// 和 AI 的私聊、群里成员的家都用这一套，只有「以后都允许」记在哪不一样。
import { Confirmation, type ConfirmDecision } from '@oasis/contracts/model-gateway';
import { HttpError, type ServiceClient } from '@oasis/service-kit';
import {
  withMessageLock,
  type Conversation,
  type ConversationRepo,
} from '../repo/conversation-repo.ts';

export function createConfirmations(deps: { repo: ConversationRepo; modelGateway: ServiceClient }) {
  return {
    /**
     * 点这份会话正在做的一轮的一张确认卡。「以后都允许」：这一轮里同类的自动允许（model-gateway 记在这一轮
     * 的 Key 上），remember 把这一类记进以后的权限（下一轮起不再问）。点过的卡马上从这一轮上收起。
     */
    async decide(
      conversation: Conversation,
      input: { confirmationId: string; decision: ConfirmDecision; requestId: string },
      remember: (store: ConversationRepo, kind: Confirmation['kind']) => Promise<void>,
    ): Promise<Confirmation> {
      const turn = conversation.turn;
      if (!turn) throw new HttpError(409, 'turn_not_active', '这一轮已经结束，不用再确认了');
      const decided = await deps.modelGateway.json(
        'POST',
        `/internal/v1/confirmations/${input.confirmationId}/decide`,
        {
          body: { runId: turn.runId, decision: input.decision },
          requestId: input.requestId,
          schema: Confirmation,
        },
      );
      const always = input.decision === 'always' && decided.status === 'allowed';
      await withMessageLock(deps.repo, conversation.id, async (store) => {
        const latest = await store.find(conversation.id);
        if (!latest) return;
        if (always) await remember(store, decided.kind);
        if (latest.turn?.runId !== turn.runId) return;
        const left = (latest.turn.confirmations ?? []).filter(
          (card) => card.id !== decided.id && !(always && card.kind === decided.kind),
        );
        await store.updateTurn(latest.id, turn.runId, { confirmations: left });
      });
      return decided;
    },
  };
}
export type Confirmations = ReturnType<typeof createConfirmations>;
