// 私聊里发话的地方共用一套：输入框、问卷卡的回答、任务单的确认、「继续」都是往对话里发一句话。
// 同一时间只发一条；发出去后把新消息接到列表末尾，再刷新消息、私聊列表和额度。
import type { MessageList, SendResult } from '@oasis/contracts/conversation';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, sendMessage, stopTurn, walletQuery } from '../api/queries.ts';

export interface ChatActions {
  conversationId: string;
  /** 正在发的是哪个操作（如 'answer'）；没有为 null */
  busy: string | null;
  error: string | null;
  /** 有一轮在进行：再发的话是插话 */
  turnActive: boolean;
  /** 发一句话，可以带文件；返回是否发出去了（没发出去时原因在 error 里） */
  say: (name: string, content: string, attachments?: string[]) => Promise<boolean>;
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

/** 发出去的结果并进已有的消息：已有的换成新的，新的接在后面 */
function mergeSent(old: MessageList | undefined, sent: SendResult): MessageList {
  const messages = old?.messages ?? [];
  const fresh = new Map(sent.messages.map((m) => [m.id, m]));
  return {
    messages: [
      ...messages.map((m) => fresh.get(m.id) ?? m),
      ...sent.messages.filter((m) => !messages.some((o) => o.id === m.id)),
    ],
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

  const say = useCallback<ChatActions['say']>(
    async (name, content, attachments = []) => {
      const key = messagesQuery(conversationId).queryKey;
      setBusy(name);
      setError(null);
      try {
        const sent = await sendMessage(conversationId, { content, attachments });
        queryClient.setQueryData(key, (old: MessageList | undefined) => mergeSent(old, sent));
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '没发出去，请重试');
        return false;
      } finally {
        setBusy(null);
        void queryClient.invalidateQueries({ queryKey: key });
        void queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
        void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      }
    },
    [conversationId, queryClient],
  );

  const stop = useCallback(async () => {
    setBusy('stop');
    setError(null);
    try {
      await stopTurn(conversationId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '没停下来，请重试');
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: messagesQuery(conversationId).queryKey });
    }
  }, [conversationId, queryClient]);

  return useMemo(
    () => ({ conversationId, busy, error, turnActive, say, stop, focusComposer }),
    [conversationId, busy, error, turnActive, say, stop, focusComposer],
  );
}
