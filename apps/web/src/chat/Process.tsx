// 干活的过程：按发生的顺序列出步骤、边做边说的话、系统提示，下面是待办。
// 聊天里不整段铺开：私聊里收成一行、点开才看（ProcessFold）；群里在工作台的任务卡上看。
import type { MessagePart, StepPart, TodoItem } from '@oasis/contracts/conversation';
import { Check, Info, LoaderCircle, X } from 'lucide-react';
import { Markdown } from './Markdown.tsx';

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

/** 过程里有几步、几步没成、正在做哪一步 */
export function stepFacts(parts: MessagePart[]) {
  const steps = parts.filter((part) => part.type === 'step');
  return {
    count: steps.length,
    failed: steps.filter((step) => step.status === 'failed').length,
    running: steps.findLast((step) => step.status === 'running'),
  };
}

/** 过程本身：步骤一行一个，边做边说的话和系统提示夹在中间，最后是待办 */
export function ProcessBody({
  parts,
  todos,
  live,
}: {
  parts: MessagePart[];
  todos?: TodoItem[] | undefined;
  live: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <ol aria-label="步骤" className="m-0 flex list-none flex-col gap-1 p-0">
        {parts.map((part, index) =>
          part.type === 'step' ? (
            <li key={index} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <StepIcon status={part.status} />
                <span className="min-w-0 break-words">{part.label}</span>
                <span className="sr-only">：{STATUS_TEXT[part.status]}</span>
              </span>
              {part.detail && (
                <span className="whitespace-pre-wrap break-words pl-5 text-[12px] text-accent">
                  {part.detail}
                </span>
              )}
            </li>
          ) : part.type === 'notice' ? (
            <li key={index} className="flex items-center gap-1.5 text-[12.5px] text-ink-muted">
              <Info size={13} aria-hidden="true" />
              {part.text}
            </li>
          ) : (
            <li
              key={index}
              className="my-1 rounded-item bg-glass-strong/60 px-3 py-2 text-ink [overflow-wrap:anywhere]"
            >
              <Markdown source={part.text} />
            </li>
          ),
        )}
      </ol>
      {todos && todos.length > 0 && <Todos items={todos} live={live} />}
    </div>
  );
}

/** 私聊里的过程：收成一行（正在做的那一步，或一共做了几步），点开才看 */
export function ProcessFold({
  parts,
  todos,
  live,
}: {
  parts: MessagePart[];
  todos?: TodoItem[] | undefined;
  live: boolean;
}) {
  const { count, failed, running } = stepFacts(parts);
  return (
    <details className="group rounded-item bg-glass-strong/60 px-3 py-2 text-[13px]">
      <summary className="flex cursor-pointer items-center gap-2 text-ink-muted">
        {running ? (
          <>
            <StepIcon status="running" />
            <span className="min-w-0 truncate text-ink">{running.label}</span>
            <span className="shrink-0">第 {count} 步</span>
          </>
        ) : (
          <span>
            {live ? '做到' : '做了'} {count} 步{failed ? `，${failed} 步没成` : ''}
          </span>
        )}
      </summary>
      <div className="mt-2">
        <ProcessBody parts={parts} todos={todos} live={live} />
      </div>
    </details>
  );
}
