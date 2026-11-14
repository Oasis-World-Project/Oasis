// 私聊里的一条消息：用户的话（带的文件、要改的成果）、AI 一轮里的一段话和步骤、任务卡、开新话题的分隔。
import type { MessageArtifact, MessageBody } from '@oasis/contracts/conversation';
import { Link } from '@tanstack/react-router';
import { PencilLine } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AiMessage } from './AiMessage.tsx';
import { SentAttachments } from './Attachments.tsx';
import { CardButton, type Speaker } from './parts.tsx';
import { TaskCard } from './TaskCard.tsx';

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

/** 很长的话（比如粘贴的大段材料、批注）只显示开头，全文在对话框里 */
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

/** 「让 AI 改」时带上的成果：点开回到画布里的这份成果 */
function RevisedArtifacts({ artifacts }: { artifacts: MessageArtifact[] }) {
  return (
    <ul
      aria-label="要改的成果"
      className="m-0 -mt-2 flex list-none flex-wrap justify-end gap-1.5 p-0"
    >
      {artifacts.map((a) => (
        <li key={a.id}>
          <Link
            to="/canvas/artifacts/$artifactId"
            params={{ artifactId: a.id }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-glass-active px-3 text-[12.5px] text-ink no-underline shadow-edge-strong"
          >
            <PencilLine size={13} aria-hidden="true" />
            要改：{a.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function UserMessage({
  message,
  waiting,
}: {
  message: Extract<MessageBody, { kind: 'text' }>;
  /** 插话送进去了、AI 还没看到（它做完手上这一步才看） */
  waiting: boolean;
}) {
  const { attachments = [], artifacts = [], interjection, pending } = message.data;
  return (
    <>
      <div className="flex flex-col items-end gap-1">
        {(interjection || pending) && (
          <span className="text-[11.5px] text-ink-muted">
            {pending
              ? '这一轮在收尾，下一轮开头交给 AI'
              : waiting
                ? '插话 · AI 做完手上这一步就会看到'
                : '插话'}
          </span>
        )}
        <div className={`${BUBBLE} m-0 bg-glass-active shadow-raised`}>
          <MessageText content={message.content} />
        </div>
      </div>
      {artifacts.length > 0 && <RevisedArtifacts artifacts={artifacts} />}
      {attachments.length > 0 && <SentAttachments attachments={attachments} />}
    </>
  );
}

export function MessageItem({
  message,
  messages,
  index,
  speaker,
}: {
  message: MessageBody;
  /** 整个列表：判断是不是最新的一条、插话 AI 看到没有 */
  messages: MessageBody[];
  index: number;
  speaker: Speaker;
}) {
  const later = messages.slice(index + 1);
  switch (message.kind) {
    case 'task':
      return <TaskCard card={message.data} speaker={speaker} />;
    case 'topic':
      return (
        <div role="separator" className="flex items-center gap-3 py-1 text-[12px] text-ink-muted">
          <span className="h-px flex-1 bg-hairline" />
          开了新话题 · AI 从这里起不记得之前的事
          <span className="h-px flex-1 bg-hairline" />
        </div>
      );
    case 'text':
      if (message.role === 'user')
        return (
          <UserMessage
            message={message}
            // AI 看到插话才在它后面接着写：前面那段还在写、后面还没有 AI 的话，就是还没看到
            waiting={
              Boolean(message.data.interjection) &&
              messages
                .slice(0, index)
                .some((m) => m.role === 'assistant' && m.status === 'streaming') &&
              !later.some((m) => m.role === 'assistant' && m.kind === 'text')
            }
          />
        );
      return (
        <AiMessage
          message={message}
          speaker={speaker}
          // 后面只有任务卡（没有新的话、没开新话题）就是最新的
          latest={later.every((m) => m.kind === 'task')}
        />
      );
  }
}
