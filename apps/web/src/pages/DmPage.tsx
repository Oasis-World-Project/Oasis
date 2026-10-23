// 和一个 AI 私聊：历史消息 + 流式回复；在这里交代任务、回答问题卡、确认任务单、看进度、拿成果（ADR 0005）。
// 回复期间输入框锁定；失败的回复会写明原因。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, walletQuery } from '../api/queries.ts';
import { sendMessage } from '../api/stream.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { Composer } from '../chat/Composer.tsx';
import { Bubble, MessageItem } from '../chat/MessageItem.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { ChatActionsContext, useChatActionsValue } from '../chat/use-chat-actions.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { AiAvatar } from '../ui/Avatar.tsx';

const route = getRouteApi('/shell/dms/$conversationId');

export function DmPage() {
  const { conversationId } = route.useParams();
  const queryClient = useQueryClient();
  const models = useModelMap();
  const { data: dms } = useQuery(dmsQuery);
  const messages = useQuery(messagesQuery(conversationId));
  const conversation = dms?.find((dm) => dm.id === conversationId);
  const model = conversation?.modelKey ? models.get(conversation.modelKey) : undefined;
  const speaker = { mono: model?.mono ?? 'AI', glow: model?.glow ?? 'var(--oasis-accent)' };

  const [hint, setHint] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToBottom = useStickToBottom(scroller, content);
  const input = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments();
  const [dragging, setDragging] = useState(false);

  const focusComposer = useCallback((nextHint?: string) => {
    setHint(nextHint ?? null);
    input.current?.focus();
  }, []);
  const actions = useChatActionsValue(conversationId, focusComposer);
  const locked = sending || actions.busy !== null;

  // 回复结束后输入框解锁，把焦点还回去，方便接着打字
  useEffect(() => {
    if (!locked) input.current?.focus();
  }, [locked]);

  /** 发出去；返回是否已被收下（没收下时输入框把草稿还回来） */
  async function send(content: string, asTask: boolean): Promise<boolean> {
    if (locked) return false;
    const key = messagesQuery(conversationId).queryKey;
    setSending(true);
    setNotice(null);
    setHint(null);
    scrollToBottom();
    let accepted = false;
    try {
      await sendMessage(
        conversationId,
        { content, asTask, attachments: attachments.ids },
        (event) => {
          if (event.type === 'accepted') {
            accepted = true;
            attachments.clear();
            queryClient.setQueryData(key, (old: MessageBody[] = []) => [...old, event.userMessage]);
            setStreaming('');
          } else if (event.type === 'delta') {
            setStreaming((text) => (text ?? '') + event.text);
          } else if (event.type === 'done') {
            queryClient.setQueryData(key, (old: MessageBody[] = []) => [...old, event.message]);
            setStreaming(null);
          }
          // 'error'：失败原因会随失败的那条回复一起显示，这里不重复提示
        },
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '发送失败了，请重试');
    } finally {
      setStreaming(null);
      setSending(false);
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
    }
    return accepted;
  }

  // 文件拖进对话区就加到要发送的文件里
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event) || locked) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget === event.target) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event) || locked) return;
      event.preventDefault();
      setDragging(false);
      attachments.add(event.dataTransfer.files);
    },
  };

  const list = messages.data ?? [];

  return (
    <ChatActionsContext.Provider value={actions}>
      <section
        aria-label="私聊"
        className={`glass relative flex h-[calc(100vh-44px)] min-h-[520px] flex-col rounded-panel ${
          dragging ? 'outline-2 -outline-offset-8 outline-dashed outline-accent' : ''
        }`}
        {...dropProps}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <AiAvatar mono={speaker.mono} glow={speaker.glow} size={40} glowing />
          <div className="flex flex-col">
            <h1 className="m-0 text-[17px] font-medium">{conversation?.title ?? '私聊'}</h1>
            <span className="text-xs text-ink-muted">{model?.versionLabel ?? '系统默认设定'}</span>
          </div>
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto px-6 py-5" aria-live="polite">
          <div ref={content} className="flex flex-col gap-4">
            {messages.isPending && <p className="m-0 text-sm text-ink-muted">正在加载消息…</p>}
            {list.length === 0 && !messages.isPending && streaming === null && (
              <p className="m-0 self-center pt-10 text-center text-sm text-ink-muted">
                打个招呼，开始和 {conversation?.title ?? 'AI'} 聊天吧。
                <br />
                想让 AI 团队做出成果，点输入框左边的「＋」作为任务发布，也可以附上文件。
              </p>
            )}
            {list.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                messages={list}
                index={index}
                speaker={speaker}
              />
            ))}
            {streaming !== null && (
              <Bubble
                message={{
                  role: 'assistant',
                  content: streaming,
                  status: 'streaming',
                  error: null,
                }}
                speaker={speaker}
              />
            )}
          </div>
        </div>

        <footer className="flex flex-col gap-2 px-6 pb-5 pt-2">
          {(notice ?? actions.error) && (
            <p role="alert" className="m-0 text-[13px] text-accent">
              {notice ?? actions.error}
            </p>
          )}
          <Composer
            locked={locked}
            sending={sending}
            hint={hint}
            inputRef={input}
            attachments={attachments}
            onSend={send}
          />
        </footer>
      </section>
    </ChatActionsContext.Provider>
  );
}
