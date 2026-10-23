// 私聊里的一条消息：文字气泡，或问题卡、任务单卡、任务卡、交付消息、提醒（ADR 0005 §7）。
import type { MessageBody } from '@oasis/contracts/conversation';
import { startIntake } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { DeliveryCard, NoticeCard } from './DeliveryCard.tsx';
import { CardButton, type Speaker } from './parts.tsx';
import { QuestionsCard } from './QuestionsCard.tsx';
import { SheetCard } from './SheetCard.tsx';
import { TaskCard } from './TaskCard.tsx';
import { useChatActions } from './use-chat-actions.ts';

const BUBBLE =
  'max-w-[72%] whitespace-pre-wrap break-words rounded-card px-4 py-2.5 text-[14.5px] leading-relaxed';

export function Bubble({
  message,
  speaker,
}: {
  message: Pick<MessageBody, 'role' | 'content' | 'status' | 'error'>;
  speaker: Speaker;
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
      <AiAvatar
        mono={speaker.mono}
        glow={speaker.glow}
        size={30}
        glowing={message.status === 'streaming'}
      />
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
}: {
  message: MessageBody;
  /** 整个列表：判断卡片是不是最新的、找上一条用户消息 */
  messages: MessageBody[];
  index: number;
  speaker: Speaker;
}) {
  const later = messages.slice(index + 1);
  switch (message.kind) {
    case 'questions':
      return (
        <QuestionsCard
          messageId={message.id}
          card={message.data}
          active={!later.some((m) => m.role === 'assistant')}
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
      return (
        <>
          <Bubble message={message} speaker={speaker} />
          {suggest && <SuggestTask fromMessageId={asked.id} />}
        </>
      );
    }
  }
}
