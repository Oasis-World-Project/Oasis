// 和一个 AI 私聊：历史消息 + 流式回复；在这里交代任务、回答问题卡、确认任务单、看进度、拿成果（ADR 0005）。
// 回复期间输入框锁定；失败的回复会写明原因。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError, apiVoid } from '../api/client.ts';
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
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
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
  async function send(
    content: string,
    asTask: boolean,
    replaceMessageId?: string,
    continuing = false,
  ): Promise<boolean> {
    if (locked) return false;
    const key = messagesQuery(conversationId).queryKey;
    setSending(true);
    setNotice(null);
    setHint(null);
    if (!replaceMessageId) scrollToBottom();
    let accepted = false;
    let acceptedMessageId: string | null = null;
    try {
      await sendMessage(
        conversationId,
        { content, asTask, attachments: attachments.ids },
        (event) => {
          if (event.type === 'accepted') {
            accepted = true;
            acceptedMessageId = event.userMessage.id;
            if (!replaceMessageId) attachments.clear();
            setReplyTo(
              event.userMessage.kind === 'text' && event.userMessage.data.intent === 'task'
                ? null
                : event.userMessage.id,
            );
            queryClient.setQueryData(key, (old: MessageBody[] = []) => {
              const index = old.findIndex((m) => m.id === event.userMessage.id);
              if (index < 0) return [...old, event.userMessage];
              const nextUser = old.findIndex((m, i) => i > index && m.role === 'user');
              return old.flatMap((m, i) =>
                m.id === event.userMessage.id
                  ? [event.userMessage]
                  : replaceMessageId &&
                      m.kind === 'text' &&
                      m.role === 'assistant' &&
                      (m.data.replyTo === replaceMessageId ||
                        (i > index && (nextUser < 0 || i < nextUser)))
                    ? []
                    : [m],
              );
            });
            setStreaming('');
          } else if (event.type === 'activity' && event.phase === 'intake') {
            setReplyTo(null);
            queryClient.setQueryData(key, (old: MessageBody[] = []) =>
              old.map((m) =>
                m.role === 'user' && m.kind === 'text' && m.id === acceptedMessageId
                  ? { ...m, data: { ...m.data, intent: 'task' as const } }
                  : m,
              ),
            );
          } else if (event.type === 'delta') {
            setStreaming((text) => (text ?? '') + event.text);
          } else if (event.type === 'done') {
            queryClient.setQueryData(key, (old: MessageBody[] = []) => {
              const found = old.some((m) => m.id === event.message.id);
              if (found) return old.map((m) => (m.id === event.message.id ? event.message : m));
              const replyTo =
                event.message.kind === 'text' ? event.message.data.replyTo : undefined;
              const userIndex = old.findIndex((m) => m.id === replyTo);
              return userIndex < 0
                ? [...old, event.message]
                : [...old.slice(0, userIndex + 1), event.message, ...old.slice(userIndex + 1)];
            });
            setStreaming(null);
          } else if (event.type === 'error') setNotice(event.message);
        },
        replaceMessageId,
        continuing,
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '发送失败了，请重试');
    } finally {
      setStreaming(null);
      setSending(false);
      setReplyTo(null);
      setStopping(false);
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
    }
    return accepted;
  }

  async function stop() {
    if (!replyTo || stopping) return;
    setStopping(true);
    try {
      await apiVoid(`/conversation/v1/conversations/${conversationId}/messages/${replyTo}/stop`, {
        method: 'POST',
      });
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '停止失败，请重试');
      setStopping(false);
    }
  }

  const controls = {
    busy: locked,
    replace: (id: string, text?: string) => send(text ?? '', false, id),
    remove: (id: string) =>
      actions.run('delete-message', () =>
        apiVoid(`/conversation/v1/conversations/${conversationId}/messages/${id}`, {
          method: 'DELETE',
        }),
      ),
  };

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

  const list = (messages.data ?? []).filter((message) => message.kind !== 'notice');
  const lastText = list.at(-1);
  const resumeId =
    lastText?.kind === 'text' &&
    lastText.role === 'assistant' &&
    (lastText.data.stopped || lastText.data.resumable || lastText.status === 'failed')
      ? lastText.data.replyTo
      : undefined;
  const streamingBubble =
    streaming !== null ? (
      <Bubble
        message={{ role: 'assistant', content: streaming, status: 'streaming', error: null }}
        speaker={speaker}
      />
    ) : null;

  return (
    <ChatActionsContext.Provider value={{ ...actions, busy: sending ? 'reply' : actions.busy }}>
      <section
        aria-label="私聊"
        // overflow-hidden：面板固定一屏高，里面的东西不能把整个页面撑出第二根滚动条
        className={`glass relative flex h-[calc(100vh-44px)] min-h-[520px] flex-col overflow-hidden rounded-panel ${
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

        {/* relative：消息里视觉隐藏的单选框（sr-only 是绝对定位）以消息区为定位基准，跟着消息区裁剪和滚动；
            否则它们按整个面板定位、溢出到页面外，撑出外层滚动条，点选时浏览器还会滚动整个页面去找它 */}
        <div
          ref={scroller}
          className="relative flex-1 overflow-y-auto px-6 py-5"
          aria-live="polite"
        >
          <div ref={content} className="flex flex-col gap-4">
            {messages.isPending && messages.fetchStatus === 'fetching' && (
              <p className="m-0 text-sm text-ink-muted">正在加载消息…</p>
            )}
            {messages.isPending && messages.fetchStatus !== 'fetching' && (
              <p className="m-0 text-sm text-ink-muted">消息尚未加载，等待连接恢复。</p>
            )}
            {messages.isError && (
              <div role="alert" className="flex items-center gap-3 text-sm text-ink-muted">
                <span>
                  {messages.error instanceof Error ? messages.error.message : '消息加载失败'}
                </span>
                <button
                  type="button"
                  onClick={() => void messages.refetch()}
                  className="rounded-full bg-glass-strong px-4 py-2 text-ink"
                >
                  重试加载消息
                </button>
              </div>
            )}
            {list.length === 0 && messages.isSuccess && streaming === null && (
              <p className="m-0 self-center pt-10 text-center text-sm text-ink-muted">
                打个招呼，开始和 {conversation?.title ?? 'AI'} 聊天吧。
                <br />
                想让 AI 团队做出成果，点输入框左边的「＋」作为任务发布，也可以附上文件。
              </p>
            )}
            {list.map((message, index) => (
              <Fragment key={message.id}>
                <MessageItem
                  message={message}
                  messages={list}
                  index={index}
                  speaker={speaker}
                  controls={controls}
                />
                {message.id === replyTo && streamingBubble}
              </Fragment>
            ))}
            {(!replyTo || !list.some((m) => m.id === replyTo)) && streamingBubble}
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
            onStop={sending && replyTo ? () => void stop() : undefined}
            stopping={stopping}
            onContinue={resumeId ? () => void send('', false, resumeId, true) : undefined}
          />
        </footer>
      </section>
    </ChatActionsContext.Provider>
  );
}
