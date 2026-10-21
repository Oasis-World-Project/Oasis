// 和一个 AI 私聊：历史消息 + 流式回复。回复期间输入框锁定；失败的回复会写明原因。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, walletQuery } from '../api/queries.ts';
import { sendMessage } from '../api/stream.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AiAvatar } from '../ui/Avatar.tsx';

const route = getRouteApi('/shell/dms/$conversationId');

const BUBBLE =
  'max-w-[72%] whitespace-pre-wrap break-words rounded-card px-4 py-2.5 text-[14.5px] leading-relaxed';

function Bubble({
  message,
  mono,
  glow,
}: {
  message: Pick<MessageBody, 'role' | 'content' | 'status' | 'error'>;
  mono: string;
  glow: string;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className={`${BUBBLE} m-0 bg-glass-active shadow-raised`}>{message.content}</p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar mono={mono} glow={glow} size={30} glowing={message.status === 'streaming'} />
      <div className={`${BUBBLE} bg-glass-strong shadow-edge-strong`}>
        {message.content ||
          (message.status === 'streaming' ? <span className="text-ink-muted">正在想…</span> : null)}
        {message.status === 'failed' && (
          <span className="mt-1 block text-[12.5px] text-accent">
            {message.error ?? '回复失败了'}
          </span>
        )}
      </div>
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
  const mono = model?.mono ?? 'AI';
  const glow = model?.glow ?? 'var(--oasis-accent)';

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // 回复结束后输入框解锁，把焦点还回去，方便接着打字
  useEffect(() => {
    if (!sending) input.current?.focus();
  }, [sending]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.length, streaming]);

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    const key = messagesQuery(conversationId).queryKey;
    setSending(true);
    setNotice(null);
    setDraft('');
    let accepted = false;
    try {
      await sendMessage(conversationId, content, (event) => {
        if (event.type === 'accepted') {
          accepted = true;
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

  return (
    <section
      aria-label="私聊"
      className="glass flex h-[calc(100vh-44px)] min-h-[520px] flex-col rounded-panel"
    >
      <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
        <AiAvatar mono={mono} glow={glow} size={40} glowing />
        <div className="flex flex-col">
          <h1 className="m-0 text-[17px] font-medium">{conversation?.title ?? '私聊'}</h1>
          <span className="text-xs text-ink-muted">{model?.versionLabel ?? '系统默认设定'}</span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5" aria-live="polite">
        {messages.isPending && <p className="m-0 text-sm text-ink-muted">正在加载消息…</p>}
        {messages.data?.length === 0 && streaming === null && (
          <p className="m-0 self-center pt-10 text-sm text-ink-muted">
            打个招呼，开始和 {conversation?.title ?? 'AI'} 聊天吧。
          </p>
        )}
        {messages.data?.map((message) => (
          <Bubble key={message.id} message={message} mono={mono} glow={glow} />
        ))}
        {streaming !== null && (
          <Bubble
            message={{ role: 'assistant', content: streaming, status: 'streaming', error: null }}
            mono={mono}
            glow={glow}
          />
        )}
        <div ref={bottom} />
      </div>

      <footer className="flex flex-col gap-2 px-6 pb-5 pt-2">
        {notice && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {notice}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-card bg-glass-active p-2 pl-4 shadow-edge-strong">
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
            disabled={sending}
            placeholder={sending ? 'AI 正在回复…' : '发消息…'}
            className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent py-2 text-[14.5px] text-ink outline-none placeholder:text-ink-muted"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            aria-label="发送"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border-0 bg-accent text-on-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
        <p className="m-0 px-1 text-[11.5px] text-ink-muted">Enter 发送 · Shift + Enter 换行</p>
      </footer>
    </section>
  );
}
