// 私聊里发话的地方共用一套：输入框、问卷卡的回答、任务单的确认、「继续」都是往对话里发一句话。
// AI 干活时发的话先排队，排着的可以「引导」（现在交给 AI）或删掉。
// 同一时间只做一件；做完把新消息接到列表末尾，再刷新消息、私聊列表和额度。
import type { MessageList, SendResult } from '@oasis/contracts/conversation';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ApiError } from '../api/client.ts';
import {
  dmsQuery,
  messagesQuery,
  sendMessage,
  steerMessage,
  stopTurn,
  unqueueMessage,
  walletQuery,
} from '../api/queries.ts';

export interface ChatActions {
  conversationId: string;
  /** 正在做的是哪个操作（如 'answer'）；没有为 null */
  busy: string | null;
  error: string | null;
  /** 有一轮在进行：再发的话先排队 */
  turnActive: boolean;
  /** 发一句话，可以带文件；返回是否发出去了（没发出去时原因在 error 里） */
  say: (name: string, content: string, attachments?: string[]) => Promise<boolean>;
  /** 「引导」：排着队的一句现在交给 AI */
  steer: (messageId: string) => Promise<void>;
  /** 从队里删掉一句；返回是否删掉了 */
  unqueue: (messageId: string) => Promise<boolean>;
  /** 停下正在进行的一轮（已经做出来的存下，说「继续」接着做） */
  stop: () => Promise<void>;
  /** 让输入框获得焦点，并换一句提示（如「说说要改哪里」） */
  focusComposer: (hint?: string) => void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) throw new Error('useChatActions 只能在私聊页里用');
  return actions;
}

/** 发出去（或引导）的结果并进已有的消息：这次的消息都排到最后（引导的那句从队里挪到最后） */
function mergeSent(old: MessageList | undefined, sent: SendResult): MessageList {
  const fresh = new Set(sent.messages.map((m) => m.id));
  return {
    messages: [...(old?.messages ?? []).filter((m) => !fresh.has(m.id)), ...sent.messages],
    turn: sent.turn,
  };
}

export function useChatActionsValue(
  conversationId: string,
  turnActive: boolean,
  focusComposer: (hint?: string) => void,
): ChatActions {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 做一件事：同一时间只做一件，出错把原因写进 error，做完刷新 */
  const run = useCallback(
    async (name: string, work: () => Promise<void>, failed: string): Promise<boolean> => {
      setBusy(name);
      setError(null);
      try {
        await work();
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : failed);
        return false;
      } finally {
        setBusy(null);
        void queryClient.invalidateQueries({ queryKey: messagesQuery(conversationId).queryKey });
        void queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
        void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      }
    },
    [conversationId, queryClient],
  );

  const merge = useCallback(
    (sent: SendResult) => {
      queryClient.setQueryData(
        messagesQuery(conversationId).queryKey,
        (old: MessageList | undefined) => mergeSent(old, sent),
      );
    },
    [conversationId, queryClient],
  );

  const say = useCallback<ChatActions['say']>(
    (name, content, attachments = []) =>
      run(
        name,
        async () => merge(await sendMessage(conversationId, { content, attachments })),
        '没发出去，请重试',
      ),
    [conversationId, merge, run],
  );

  const steer = useCallback<ChatActions['steer']>(
    async (messageId) => {
      await run(
        'steer',
        async () => merge(await steerMessage(conversationId, messageId)),
        '没交给 AI，请重试',
      );
    },
    [conversationId, merge, run],
  );

  const unqueue = useCallback<ChatActions['unqueue']>(
    (messageId) =>
      run(
        'unqueue',
        async () => {
          await unqueueMessage(conversationId, messageId);
          queryClient.setQueryData(
            messagesQuery(conversationId).queryKey,
            (old: MessageList | undefined) =>
              old && { ...old, messages: old.messages.filter((m) => m.id !== messageId) },
          );
        },
        '没删掉，请重试',
      ),
    [conversationId, queryClient, run],
  );

  const stop = useCallback(async () => {
    await run('stop', () => stopTurn(conversationId), '没停下来，请重试');
  }, [conversationId, run]);

  return useMemo(
    () => ({ conversationId, busy, error, turnActive, say, steer, unqueue, stop, focusComposer }),
    [conversationId, busy, error, turnActive, say, steer, unqueue, stop, focusComposer],
  );
}
