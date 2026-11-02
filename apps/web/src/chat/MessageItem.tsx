// 私聊里的一条消息：文字气泡，或问题卡、任务单卡、任务卡、交付消息、提醒（ADR 0005 §7）。
import type { MessageBody } from '@oasis/contracts/conversation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { startIntake } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { SentAttachments } from './Attachments.tsx';
import { DeliveryCard, NoticeCard } from './DeliveryCard.tsx';
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

function TextActions({ message, controls }: { message: MessageBody; controls: MessageControls }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  return (
    <div className="-mt-2 flex justify-end gap-2 text-xs text-ink-muted">
      <CardButton
        disabled={controls.busy}
        onClick={() => {
          setDraft(message.content);
          setEditing(true);
        }}
      >
        编辑
      </CardButton>
      <CardButton disabled={controls.busy} onClick={() => void controls.replace(message.id)}>
        重新生成
      </CardButton>
      <CardButton disabled={controls.busy} onClick={() => void controls.remove(message.id)}>
        删除
      </CardButton>
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
          // 后面已经有这个任务的提醒时，选择放在提醒里（离输入框近），任务卡不重复
          decisions={
            !later.some((m) => m.kind === 'notice' && m.data.taskId === message.data.taskId)
          }
        />
      );
    case 'delivery':
      return <DeliveryCard card={message.data} speaker={speaker} />;
    case 'notice':
      return <NoticeCard card={message.data} speaker={speaker} />;
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
