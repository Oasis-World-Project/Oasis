// AI 在一轮里的一段消息：按发生的顺序显示它说的话（里面的问卷、任务单画成卡片）、做的步骤（默认折叠）、
// 系统提示，下面是它的待办（只作参考）、结局（出错、已停下）和这一轮的花费。
import type { MessageBody, MessagePart, StepPart, TodoItem } from '@oasis/contracts/conversation';
import { Check, Info, LoaderCircle, X } from 'lucide-react';
import { Fragment } from 'react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { splitBlocks } from './blocks.ts';
import { Markdown } from './Markdown.tsx';
import { CardButton, type Speaker } from './parts.tsx';
import { QuestionsCard } from './QuestionsCard.tsx';
import { SheetCard } from './SheetCard.tsx';
import { useChatActions } from './use-chat-actions.ts';

type TextMessage = Extract<MessageBody, { kind: 'text' }>;

/** 连着的几步并成一组 */
type Group =
  | { kind: 'text'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'steps'; steps: StepPart[] };

function groupParts(parts: MessagePart[]): Group[] {
  const groups: Group[] = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (part.type === 'step') {
      if (last?.kind === 'steps') last.steps.push(part);
      else groups.push({ kind: 'steps', steps: [part] });
    } else groups.push({ kind: part.type, text: part.text });
  }
  return groups;
}

export function StepIcon({ status }: { status: StepPart['status'] }) {
  if (status === 'running')
    return <LoaderCircle size={13} aria-hidden="true" className="animate-spin text-accent" />;
  if (status === 'failed') return <X size={13} aria-hidden="true" className="text-accent" />;
  return <Check size={13} aria-hidden="true" className="text-ink-muted" />;
}

const STATUS_TEXT: Record<StepPart['status'], string> = {
  running: '进行中',
  done: '完成',
  failed: '没成',
};

/** 一组步骤：折叠时显示正在做的那一步，或一共做了几步 */
export function Steps({ steps }: { steps: StepPart[] }) {
  const running = steps.findLast((s) => s.status === 'running');
  const failed = steps.filter((s) => s.status === 'failed').length;
  return (
    <details className="group rounded-item bg-glass-strong/60 px-3 py-2 text-[13px]">
      <summary className="flex cursor-pointer items-center gap-2 text-ink-muted">
        {running ? (
          <>
            <StepIcon status="running" />
            <span className="truncate text-ink">{running.label}</span>
          </>
        ) : (
          <span>
            做了 {steps.length} 步{failed ? `，${failed} 步没成` : ''}
          </span>
        )}
      </summary>
      <ol aria-label="步骤" className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <StepIcon status={step.status} />
              <span className="min-w-0 break-words">{step.label}</span>
              <span className="sr-only">：{STATUS_TEXT[step.status]}</span>
            </span>
            {step.detail && (
              <span className="whitespace-pre-wrap break-words pl-5 text-[12px] text-accent">
                {step.detail}
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** AI 列的待办：一轮进行中展开；结束后没做完的变灰 */
export function Todos({ items, live }: { items: TodoItem[]; live: boolean }) {
  const done = items.filter((t) => t.status === 'done').length;
  return (
    <details open={live} className="rounded-item bg-glass-strong/60 px-3 py-2 text-[13px]">
      <summary className="cursor-pointer text-ink-muted">
        待办 {done}/{items.length}
      </summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
        {items.map((item, index) => (
          <li
            key={index}
            className={`flex items-center gap-2 ${
              item.status === 'done'
                ? 'text-ink-muted line-through'
                : !live
                  ? 'text-ink-muted opacity-60'
                  : item.status === 'doing'
                    ? 'font-medium text-ink'
                    : 'text-ink'
            }`}
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${
                item.status === 'done'
                  ? 'bg-ink-muted'
                  : item.status === 'doing' && live
                    ? 'bg-accent'
                    : 'border border-ink-muted'
              }`}
            />
            {item.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** AI 说的一段话：Markdown，代码块里的问卷和任务单画成卡片 */
function AiText({ id, text, active }: { id: string; text: string; active: boolean }) {
  return (
    <>
      {splitBlocks(text).map((block, index) =>
        block.kind === 'text' ? (
          <div
            key={index}
            className="rounded-card bg-glass-strong px-4 py-2.5 shadow-edge-strong [overflow-wrap:anywhere]"
          >
            <Markdown source={block.text} />
          </div>
        ) : block.kind === 'questions' ? (
          <QuestionsCard key={index} id={`${id}-${index}`} block={block.data} active={active} />
        ) : (
          <SheetCard key={index} block={block.data} active={active} />
        ),
      )}
    </>
  );
}

export function AiMessage({
  message,
  speaker,
  latest,
}: {
  message: TextMessage;
  speaker: Speaker;
  /** 是最新的一条（后面没有新的话）：问卷能答、任务单能确认、出错了能「继续」 */
  latest: boolean;
}) {
  const actions = useChatActions();
  const { parts = [], todos, stopped, spentMicro } = message.data;
  const live = message.status === 'streaming';
  const canContinue =
    latest && !actions.turnActive && (message.status === 'failed' || Boolean(stopped));
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar mono={speaker.mono} glow={speaker.glow} size={30} glowing={live} />
      <div className="flex min-w-0 max-w-[80%] flex-col gap-2 text-[14.5px] leading-relaxed">
        {groupParts(parts).map((group, index) => (
          <Fragment key={index}>
            {group.kind === 'text' ? (
              <AiText id={`${message.id}-${index}`} text={group.text} active={latest} />
            ) : group.kind === 'steps' ? (
              <Steps steps={group.steps} />
            ) : (
              <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                <Info size={13} aria-hidden="true" />
                {group.text}
              </p>
            )}
          </Fragment>
        ))}
        {parts.length === 0 && live && <span className="text-ink-muted">正在想…</span>}
        {todos && todos.length > 0 && <Todos items={todos} live={live} />}
        {message.status === 'failed' && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {message.error ?? '这一轮出错了'}
          </p>
        )}
        {stopped && <span className="text-[12.5px] text-ink-muted">已停下</span>}
        {canContinue && (
          <div>
            <CardButton
              tone="accent"
              disabled={actions.busy !== null}
              onClick={() => void actions.say('continue', '继续')}
            >
              继续
            </CardButton>
          </div>
        )}
        {spentMicro !== undefined && spentMicro > 0 && (
          <span className="text-[12px] text-ink-muted">这一轮花了 {formatCost(spentMicro)}</span>
        )}
      </div>
    </div>
  );
}
