// 和一个 AI 私聊：它就是干活的那个 AI。说一句话开一轮，AI 说的话和做的步骤一段段写进消息（有一轮在进行时
// 每秒刷新）；一轮进行中再发的话是插话，随时可以停下；做东西的那一轮出一张任务卡。可以开新话题、删除私聊。
import type { MessageList } from '@oasis/contracts/conversation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { deleteDm, dmsQuery, messagesQuery, newTopic } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { Composer } from '../chat/Composer.tsx';
import { MessageItem } from '../chat/MessageItem.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { ChatActionsContext, useChatActionsValue } from '../chat/use-chat-actions.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { AiAvatar } from '../ui/Avatar.tsx';

const route = getRouteApi('/shell/dms/$conversationId');

export function DmPage() {
  const { conversationId } = route.useParams();
  const models = useModelMap();
  const { data: dms } = useQuery(dmsQuery);
  const messages = useQuery(messagesQuery(conversationId));
  const conversation = dms?.find((dm) => dm.id === conversationId);
  const model = conversation?.modelKey ? models.get(conversation.modelKey) : undefined;
  const speaker = { mono: model?.mono ?? 'AI', glow: model?.glow ?? 'var(--oasis-accent)' };
  const turnActive = Boolean(messages.data?.turn);

  const [hint, setHint] = useState<string | null>(null);
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
  const actions = useChatActionsValue(conversationId, turnActive, focusComposer);
  const sending = actions.busy !== null && actions.busy !== 'stop';

  // 发完把焦点还回输入框，方便接着打字
  useEffect(() => {
    if (!sending) input.current?.focus();
  }, [sending]);

  async function send(text: string): Promise<boolean> {
    setHint(null);
    scrollToBottom();
    const ok = await actions.say('send', text, attachments.ids);
    if (ok) attachments.clear();
    return ok;
  }

  // 文件拖进对话区就加到要发送的文件里（一轮进行中不能带文件）
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event) || sending || turnActive) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget === event.target) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event) || sending || turnActive) return;
      event.preventDefault();
      setDragging(false);
      attachments.add(event.dataTransfer.files);
    },
  };

  const list = messages.data?.messages ?? [];

  return (
    <ChatActionsContext.Provider value={actions}>
      <section
        aria-label="私聊"
        // overflow-hidden：面板固定一屏高，里面的东西不能把整个页面撑出第二根滚动条
        className={`glass relative flex h-[calc(100vh-44px)] min-h-[520px] flex-col overflow-hidden rounded-panel ${
          dragging ? 'outline-2 -outline-offset-8 outline-dashed outline-accent' : ''
        }`}
        {...dropProps}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <AiAvatar mono={speaker.mono} glow={speaker.glow} size={40} glowing={turnActive} />
          <div className="flex flex-col">
            <h1 className="m-0 text-[17px] font-medium">{conversation?.title ?? '私聊'}</h1>
            <span className="text-xs text-ink-muted">
              {turnActive ? '正在做…' : (model?.versionLabel ?? '系统默认设定')}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <NewTopic conversationId={conversationId} disabled={turnActive || list.length === 0} />
            <DeleteDm conversationId={conversationId} />
          </div>
        </header>

        {/* relative：消息里视觉隐藏的单选框（sr-only 是绝对定位）以消息区为定位基准，跟着消息区裁剪和滚动 */}
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
            {list.length === 0 && messages.isSuccess && (
              <p className="m-0 self-center pt-10 text-center text-sm text-ink-muted">
                打个招呼，或者直接说要做什么：写文档、做图、做视频、做网页都行。
                <br />
                可以附上文件；它做的时候你随时可以插话、问进度、让它停下。
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
          </div>
        </div>

        <footer className="flex flex-col gap-2 px-6 pb-5 pt-2">
          {actions.error && (
            <p role="alert" className="m-0 text-[13px] text-accent">
              {actions.error}
            </p>
          )}
          <Composer
            locked={sending}
            sending={sending}
            hint={hint}
            inputRef={input}
            attachments={attachments}
            onSend={send}
            turnActive={turnActive}
            onStop={() => void actions.stop()}
            stopping={actions.busy === 'stop'}
          />
        </footer>
      </section>
    </ChatActionsContext.Provider>
  );
}

/** 开新话题：AI 从这里起不记得之前的事（它的记忆和工作目录清掉，聊天记录和成果都留着） */
function NewTopic({ conversationId, disabled }: { conversationId: string; disabled: boolean }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const start = useMutation({
    mutationFn: () => newTopic(conversationId),
    onSuccess: ({ message }) => {
      queryClient.setQueryData(
        messagesQuery(conversationId).queryKey,
        (old: MessageList | undefined) =>
          old ? { ...old, messages: [...old.messages, message] } : old,
      );
    },
  });
  if (asking)
    return (
      <span
        role="group"
        aria-label="开新话题？"
        className="flex items-center gap-1.5 whitespace-nowrap"
      >
        <span className="text-[12.5px] text-ink-muted">AI 会忘掉之前聊的，成果都还在</span>
        <button
          type="button"
          onClick={() => {
            setAsking(false);
            start.mutate();
          }}
          className="h-8 rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent"
        >
          开新话题
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="h-8 rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted"
        >
          取消
        </button>
      </span>
    );
  return (
    <>
      {start.isError && (
        <span role="alert" className="text-[12.5px] text-accent">
          {start.error instanceof ApiError ? start.error.message : '没开成，请重试'}
        </span>
      )}
      <button
        type="button"
        aria-label="开新话题"
        title={disabled ? '这一轮做完才能开新话题' : '开新话题'}
        disabled={disabled || start.isPending}
        onClick={() => setAsking(true)}
        className="flex size-9 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-track hover:text-ink disabled:opacity-40"
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * 删除私聊（真删除）：右上角一个图标，点了在同一行问一句。消息、成果、AI 的记忆和工作目录都删掉；
 * 再点开这个 AI 是全新的空白私聊。
 */
function DeleteDm({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteDm(conversationId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: messagesQuery(conversationId).queryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      await navigate({ to: '/dms' });
    },
  });
  return (
    <>
      {remove.isError && (
        <span role="alert" className="text-[12.5px] text-accent">
          {remove.error instanceof ApiError ? remove.error.message : '没删掉，请重试'}
        </span>
      )}
      {asking ? (
        <span
          role="group"
          aria-label="删除这段私聊？"
          className="flex items-center gap-1.5 whitespace-nowrap"
        >
          <span className="text-[12.5px] text-ink-muted">
            聊天、成果和 AI 的记忆都删掉，不能恢复
          </span>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              setAsking(false);
              remove.mutate();
            }}
            className="h-8 rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:opacity-50"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className="h-8 rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted"
          >
            取消
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-label="删除私聊"
          title="删除私聊"
          disabled={remove.isPending}
          onClick={() => setAsking(true)}
          className="flex size-9 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-track hover:text-ink disabled:opacity-50"
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
