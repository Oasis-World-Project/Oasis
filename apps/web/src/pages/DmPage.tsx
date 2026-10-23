// 和一个 AI 私聊：历史消息 + 流式回复；在这里交代任务、回答问题卡、确认任务单、看进度、拿成果（ADR 0005）。
// 回复期间输入框锁定；失败的回复会写明原因。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowUp, ListChecks, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, walletQuery } from '../api/queries.ts';
import { sendMessage } from '../api/stream.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { Bubble, MessageItem } from '../chat/MessageItem.tsx';
import { ChatActionsContext, useChatActionsValue } from '../chat/use-chat-actions.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { AiAvatar } from '../ui/Avatar.tsx';

const route = getRouteApi('/shell/dms/$conversationId');

/** 输入框左边的「＋」：把这条消息作为任务发布 */
function ComposerMenu({
  asTask,
  onToggleTask,
  disabled,
}: {
  asTask: boolean;
  onToggleTask: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="更多发送方式"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex size-11 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-glass-strong hover:text-ink disabled:opacity-45"
      >
        <Plus size={19} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="glass absolute bottom-12 left-0 z-10 flex w-56 flex-col rounded-card bg-glass-strong p-1.5"
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={asTask}
            onClick={() => {
              onToggleTask();
              setOpen(false);
            }}
            className="flex items-center gap-2.5 rounded-item border-0 bg-transparent px-3 py-2.5 text-left text-ink hover:bg-glass-active"
          >
            <ListChecks size={17} aria-hidden="true" />
            <span className="flex flex-col">
              <span className="text-[14px] font-medium">作为任务发布</span>
              <span className="text-[12px] text-ink-muted">交给 AI 团队做出成果</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function DmPage() {
  const { conversationId } = route.useParams();
  const queryClient = useQueryClient();
  const models = useModelMap();
  const { data: dms } = useQuery(dmsQuery);
  const messages = useQuery(messagesQuery(conversationId));
  const conversation = dms?.find((dm) => dm.id === conversationId);
  const model = conversation?.modelKey ? models.get(conversation.modelKey) : undefined;
  const speaker = { mono: model?.mono ?? 'AI', glow: model?.glow ?? 'var(--oasis-accent)' };

  const [draft, setDraft] = useState('');
  const [asTask, setAsTask] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToBottom = useStickToBottom(scroller, content);
  const input = useRef<HTMLTextAreaElement>(null);

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

  async function send() {
    const content = draft.trim();
    if (!content || locked) return;
    const key = messagesQuery(conversationId).queryKey;
    setSending(true);
    setNotice(null);
    setDraft('');
    setHint(null);
    scrollToBottom();
    let accepted = false;
    try {
      await sendMessage(conversationId, { content, asTask }, (event) => {
        if (event.type === 'accepted') {
          accepted = true;
          setAsTask(false);
          queryClient.setQueryData(key, (old: MessageBody[] = []) => [...old, event.userMessage]);
          setStreaming('');
        } else if (event.type === 'delta') {
          setStreaming((text) => (text ?? '') + event.text);
        } else if (event.type === 'done') {
          queryClient.setQueryData(key, (old: MessageBody[] = []) => [...old, event.message]);
          setStreaming(null);
        }
        // 'error'：失败原因会随失败的那条回复一起显示，这里不重复提示
      });
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '发送失败了，请重试');
      if (!accepted) setDraft(content);
    } finally {
      setStreaming(null);
      setSending(false);
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法选字时按回车不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const placeholder = sending
    ? 'AI 正在回复…'
    : (hint ?? (asTask ? '说说要交付什么，比如：给我的民宿写个官网首页' : '发消息…'));
  const list = messages.data ?? [];

  return (
    <ChatActionsContext.Provider value={actions}>
      <section
        aria-label="私聊"
        className="glass flex h-[calc(100vh-44px)] min-h-[520px] flex-col rounded-panel"
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
                想让 AI 团队做出成果，点输入框左边的「＋」作为任务发布。
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
          <div className="flex items-end gap-1 rounded-card bg-glass-active p-2 shadow-edge-strong">
            <ComposerMenu
              asTask={asTask}
              onToggleTask={() => setAsTask((v) => !v)}
              disabled={locked}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              {asTask && (
                <span className="mt-1 inline-flex items-center gap-1 self-start rounded-full bg-solid py-1 pl-2.5 pr-1 text-[12px] font-medium text-on-solid">
                  任务
                  <button
                    type="button"
                    onClick={() => setAsTask(false)}
                    aria-label="不作为任务发布"
                    className="flex size-4 items-center justify-center rounded-full border-0 bg-transparent p-0 text-on-solid"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              )}
              <label htmlFor="dm-input" className="sr-only">
                消息
              </label>
              <textarea
                id="dm-input"
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                ref={input}
                autoFocus
                disabled={locked}
                placeholder={placeholder}
                className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-[14.5px] text-ink outline-none placeholder:text-ink-muted"
              />
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={locked || !draft.trim()}
              aria-label={asTask ? '发布任务' : '发送'}
              className="flex size-11 shrink-0 items-center justify-center rounded-full border-0 bg-accent text-on-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          <p className="m-0 px-1 text-[11.5px] text-ink-muted">Enter 发送 · Shift + Enter 换行</p>
        </footer>
      </section>
    </ChatActionsContext.Provider>
  );
}
