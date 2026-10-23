// 卡片上的操作（回答问题卡、确认任务单、处理任务……）共用的执行方式：
// 同一时间只做一件事；做完把新消息接到列表末尾，再刷新消息（旧卡片的状态会变）、任务和额度。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { messagesQuery, walletQuery } from '../api/queries.ts';

export interface ChatActions {
  conversationId: string;
  /** 正在做的操作（如 'answer'）；没有为 null */
  busy: string | null;
  error: string | null;
  /** 执行一个操作；返回新消息的操作把消息接到列表末尾 */
  run: (name: string, action: () => Promise<{ messages: MessageBody[] } | void>) => Promise<void>;
  /** 让输入框获得焦点，并换一句提示（如「说说要改哪里」） */
  focusComposer: (hint?: string) => void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) throw new Error('useChatActions 只能在私聊页里用');
  return actions;
}

export function useChatActionsValue(
  conversationId: string,
  focusComposer: (hint?: string) => void,
): ChatActions {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback<ChatActions['run']>(
    async (name, action) => {
      const key = messagesQuery(conversationId).queryKey;
      setBusy(name);
      setError(null);
      try {
        const result = await action();
        if (result) {
          queryClient.setQueryData(key, (old: MessageBody[] = []) => [
            ...old,
            ...result.messages.filter((m) => !old.some((o) => o.id === m.id)),
          ]);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '操作没成功，请重试');
      } finally {
        setBusy(null);
        void queryClient.invalidateQueries({ queryKey: key });
        void queryClient.invalidateQueries({ queryKey: ['task'] });
        void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      }
    },
    [conversationId, queryClient],
  );

  return useMemo(
    () => ({ conversationId, busy, error, run, focusComposer }),
    [conversationId, busy, error, run, focusComposer],
  );
}
