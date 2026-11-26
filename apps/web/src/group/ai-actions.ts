// AI 的话里能做的事（答问卷、确认任务单、「继续」）都是往对话里发一句话：群里是 @ 着它发，私聊里直接发。
// 停下是停它这一轮；私聊里排着队的话可以现在交给它（引导）或从队里删掉。
import { steerMessage, stopGroupAi, stopTurn, unqueueMessage } from '../api/queries.ts';
import type { ChatActions } from '../chat/use-chat-actions.ts';
import { dmAct, type Room } from './room.ts';

export function actionsFor(room: Room, key: string): ChatActions {
  const { group } = room;
  const dm = group.kind === 'dm';
  return {
    conversationId: group.id,
    busy: room.sending || room.busy ? 'send' : null,
    error: null,
    turnActive: Boolean(group.ais.find((ai) => ai.key === key)?.runId),
    say: (_name, content, attachments) =>
      room.send(content, dm ? [] : [{ kind: 'ai', key }], attachments ? { attachments } : {}),
    steer: async (messageId) => {
      if (dm) await dmAct(room, () => steerMessage(group.id, messageId));
    },
    unqueue: async (messageId) =>
      dm ? dmAct(room, () => unqueueMessage(group.id, messageId)) : false,
    stop: async () => {
      await (dm
        ? dmAct(room, () => stopTurn(group.id))
        : room.act(() => stopGroupAi(group.id, key)));
    },
    focusComposer: (hint) => {
      if (!dm) room.mention({ kind: 'ai', key });
      room.focus(hint);
    },
  };
}
