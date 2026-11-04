// 私聊里的一条消息：文字气泡，或问题卡、任务单卡、任务卡、交付消息、提醒（ADR 0005 §7）。
import type { MessageBody } from '@oasis/contracts/conversation';
import { PencilLine, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { startIntake } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { SentAttachments } from './Attachments.tsx';
import { DeliveryCard } from './DeliveryCard.tsx';
import { CardButton, type Speaker } from './parts.tsx';
import { QuestionsCard } from './QuestionsCard.tsx';
import { SheetCard } from './SheetCard.tsx';
import { TaskCard } from './TaskCard.tsx';
import { useChatActions } from './use-chat-actions.ts';

const BUBBLE =
  'max-w-[72%] whitespace-pre-wrap break-words rounded-card px-4 py-2.5 text-[14.5px] leading-relaxed';

function MessageDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto max-h-[80vh] w-[min(90vw,640px)] max-w-none overflow-y-auto rounded-panel border-0 bg-glass-active p-6 text-ink shadow-panel backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <header className="mb-4 flex items-center justify-between gap-4">
        <h2 className="m-0 text-base font-medium">{title}</h2>
        <CardButton onClick={onClose}>关闭</CardButton>
      </header>
      {children}
    </dialog>
  );
}

function MessageText({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const long = content.length > 360 || content.split('\n').length > 8;
  if (!long) return <>{content}</>;
  return (
    <>
      <p className="m-0 line-clamp-4">{content.slice(0, 240)}…</p>
      <button
        type="button"
        className="mt-2 rounded-item border-0 bg-glass-strong px-3 py-1 text-xs text-ink"
        onClick={() => setOpen(true)}
      >
        查看全文 · {content.length} 字
      </button>
      {open && (
        <MessageDialog title="消息全文" onClose={() => setOpen(false)}>
          <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{content}</p>
          <CardButton onClick={() => void navigator.clipboard.writeText(content)}>
            复制全文
          </CardButton>
        </MessageDialog>
      )}
    </>
  );
}

export interface MessageControls {
  busy: boolean;
  replace: (messageId: string, content?: string) => Promise<boolean>;
  remove: (messageId: string) => Promise<void>;
}

/** 消息下面的小图标按钮（2026-11-05 用户：不要字，用小图标） */
function IconAction({
  label,
  active = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup={active ? 'dialog' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-7 items-center justify-center rounded-full border-0 transition-colors disabled:opacity-40 ${
        active
          ? 'bg-glass-strong text-ink'
          : 'bg-transparent text-ink-muted hover:bg-glass-strong hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** 点了重新生成、删除先问一句：图标下面弹出的小卡片，点外面或按 Esc 收起 */
function ConfirmPopover({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // 下面放不下（最后一条消息贴着输入框）就往上弹
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const row = box.current?.parentElement?.getBoundingClientRect();
    const height = box.current?.offsetHeight ?? 0;
    if (row && row.bottom + height + 160 > window.innerHeight) setUp(true);
  }, []);
  useEffect(() => {
    cancel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onCancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [onCancel]);
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-label={title}
      className={`absolute right-0 z-20 flex w-80 max-w-[80vw] animate-[oasis-pop_140ms_ease-out] flex-col gap-3 rounded-card bg-glass-active p-4 text-ink shadow-panel backdrop-blur-md ${
        up ? 'bottom-full mb-1.5 origin-bottom-right' : 'top-full mt-1.5 origin-top-right'
      }`}
    >
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[13.5px] font-medium">{title}</p>
        <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">{detail}</p>
      </div>
      <div className="flex justify-end gap-1.5">
        <button
          ref={cancel}
          type="button"
          onClick={onCancel}
          className="h-8 rounded-full border-0 bg-transparent px-3 text-[12.5px] text-ink-muted hover:bg-glass-strong hover:text-ink"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-8 rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent hover:opacity-90"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

function TextActions({ message, controls }: { message: MessageBody; controls: MessageControls }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [asking, setAsking] = useState<'replace' | 'remove' | null>(null);
  const close = useCallback(() => setAsking(null), []);
  return (
    <div className="relative -mt-2 flex justify-end gap-0.5">
      <IconAction
        label="编辑消息"
        disabled={controls.busy}
        onClick={() => {
          setDraft(message.content);
          setEditing(true);
        }}
      >
        <PencilLine size={15} aria-hidden="true" />
      </IconAction>
      <IconAction
        label="重新生成回复"
        active={asking === 'replace'}
        disabled={controls.busy}
        onClick={() => setAsking(asking === 'replace' ? null : 'replace')}
      >
        <RotateCcw size={15} aria-hidden="true" />
      </IconAction>
      <IconAction
        label="删除消息"
        active={asking === 'remove'}
        disabled={controls.busy}
        onClick={() => setAsking(asking === 'remove' ? null : 'remove')}
      >
        <Trash2 size={15} aria-hidden="true" />
      </IconAction>
      {asking === 'replace' && (
        <ConfirmPopover
          title="重新生成回复？"
          detail="现在的回复会被新的回答替换。"
          confirmLabel="重新生成"
          onCancel={close}
          onConfirm={() => {
            setAsking(null);
            void controls.replace(message.id);
          }}
        />
      )}
      {asking === 'remove' && (
        <ConfirmPopover
          title="删除这条消息？"
          detail="连同 AI 的回复和附件一起彻底删除，不能恢复。"
          confirmLabel="删除"
          onCancel={close}
          onConfirm={() => {
            setAsking(null);
            void controls.remove(message.id);
          }}
        />
      )}
      {editing && (
        <MessageDialog title="编辑消息" onClose={() => setEditing(false)}>
          <p className="text-xs text-ink-muted">
            替换本轮回复，后续消息保留。旧内容不再进入聊天上下文。
          </p>
          <textarea
            aria-label="修改消息内容"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            maxLength={8000}
            className="w-full resize-y rounded-card border border-hairline bg-glass-strong p-3 text-sm text-ink"
          />
          <CardButton
            disabled={controls.busy || !draft.trim()}
            onClick={() => {
              setEditing(false);
              void controls.replace(message.id, draft.trim());
            }}
          >
            保存并重新生成
          </CardButton>
        </MessageDialog>
      )}
    </div>
  );
}

export function Bubble({
  message,
  speaker,
  task = false,
  stopped = false,
}: {
  message: Pick<MessageBody, 'role' | 'content' | 'status' | 'error'>;
  speaker: Speaker;
  task?: boolean;
  stopped?: boolean;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className={`${BUBBLE} m-0 bg-glass-active shadow-raised`}>
          {task && (
            <span className="mb-2 block text-xs font-medium text-accent">任务 · 已锁定</span>
          )}
          <MessageText content={message.content} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar
        mono={speaker.mono}
        glow={speaker.glow}
        size={30}
        glowing={message.status === 'streaming'}
      />
      <div className={`${BUBBLE} bg-glass-strong shadow-edge-strong`}>
        {message.content ? (
          <MessageText content={message.content} />
        ) : message.status === 'streaming' ? (
          <span className="text-ink-muted">正在想…</span>
        ) : null}
        {stopped && <span className="mt-1 block text-xs text-ink-muted">已停止</span>}
        {message.status === 'failed' && (
          <span className="mt-1 block text-[12.5px] text-accent">
            {message.error ?? '回复失败了'}
          </span>
        )}
      </div>
    </div>
  );
}

/** AI 觉得上一句可能是个任务：回复下面附「当成任务来做」 */
function SuggestTask({ fromMessageId }: { fromMessageId: string }) {
  const actions = useChatActions();
  return (
    <div className="-mt-2 pl-10">
      <CardButton
        onClick={() =>
          void actions.run('start', () => startIntake(actions.conversationId, fromMessageId))
        }
        disabled={actions.busy !== null}
      >
        {actions.busy === 'start' ? '正在整理需求…' : '当成任务来做'}
      </CardButton>
    </div>
  );
}

export function MessageItem({
  message,
  messages,
  index,
  speaker,
  controls,
}: {
  message: MessageBody;
  /** 整个列表：判断卡片是不是最新的、找上一条用户消息 */
  messages: MessageBody[];
  index: number;
  speaker: Speaker;
  controls?: MessageControls;
}) {
  const later = messages.slice(index + 1);
  switch (message.kind) {
    case 'questions':
      return (
        <QuestionsCard
          messageId={message.id}
          card={message.data}
          active={!later.some((m) => m.role === 'assistant' && m.status !== 'failed')}
          speaker={speaker}
        />
      );
    case 'sheet':
      return <SheetCard card={message.data} speaker={speaker} />;
    case 'task':
      return (
        <TaskCard
          taskId={message.data.taskId}
          speaker={speaker}
          revision={!!message.data.revisionOf}
          {...(message.data.removed ? { removed: message.data.removed } : {})}
        />
      );
    case 'delivery':
      return <DeliveryCard card={message.data} speaker={speaker} />;
    case 'notice':
      return null; // 历史过程提醒仍保存在服务端；检查原因和操作统一在工作流。
    case 'text': {
      const asked = messages
        .slice(0, index)
        .findLast((m) => m.role === 'user' && m.kind === 'text');
      const suggest = message.data.suggestTask && later.length === 0 && asked;
      const attachments = message.data.attachments ?? [];
      return (
        <>
          <Bubble
            message={message}
            speaker={speaker}
            task={message.data.intent === 'task'}
            stopped={!!message.data.stopped}
          />
          {message.role === 'user' && message.data.intent !== 'task' && controls && (
            <TextActions message={message} controls={controls} />
          )}
          {attachments.length > 0 && <SentAttachments attachments={attachments} />}
          {suggest && <SuggestTask fromMessageId={asked.id} />}
        </>
      );
    }
  }
}
