// 问卷卡：AI 回复里的 ```oasis-questions 代码块。每题选一个，选项都不合适时可以「自己写」；
// 回答作为一条普通消息发给 AI。只有最新一条 AI 回复里、后面还没有用户发言的问卷能答。
import type { QuestionsBlock } from '@oasis/contracts/conversation';
import { useState } from 'react';
import { answerText } from './blocks.ts';
import { CardActions, CardButton, CardHeading, Choice } from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

/** 选了「自己写」 */
const CUSTOM = '\u0000custom';
const CUSTOM_MAX = 200;

export function QuestionsCard({
  id,
  block,
  active,
}: {
  /** 这张卡在页面里的编号（单选框分组用） */
  id: string;
  block: QuestionsBlock;
  active: boolean;
}) {
  const actions = useChatActions();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(
    block.questions.map((q) => [
      q.id,
      picked[q.id] === CUSTOM ? (custom[q.id] ?? '').trim() : (picked[q.id] ?? ''),
    ]),
  );
  const missing = block.questions.some((q) => !answers[q.id]);
  const busy = actions.busy !== null;

  return (
    <section
      aria-label="问卷"
      className="flex flex-col gap-3.5 rounded-item bg-glass-active px-4 py-3.5 shadow-edge-strong"
    >
      <CardHeading kind={active ? '想先问清楚几件事' : '问卷'} />
      {block.questions.map((question) => {
        const name = `${id}-${question.id}`;
        const choose = (value: string) => setPicked((old) => ({ ...old, [question.id]: value }));
        if (!active)
          return (
            <div key={question.id} className="flex flex-col gap-1">
              <span className="text-[14px] font-medium">{question.text}</span>
              <span className="text-[13px] text-ink-muted">{question.options.join(' / ')}</span>
            </div>
          );
        return (
          <fieldset key={question.id} className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[14.5px] font-medium">{question.text}</legend>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => (
                <Choice
                  key={option}
                  name={name}
                  label={option}
                  checked={picked[question.id] === option}
                  onChange={() => choose(option)}
                  disabled={busy}
                />
              ))}
              <Choice
                name={name}
                label="自己写"
                checked={picked[question.id] === CUSTOM}
                onChange={() => choose(CUSTOM)}
                disabled={busy}
              />
            </div>
            {picked[question.id] === CUSTOM && (
              <input
                type="text"
                autoFocus
                aria-label={`${question.text}：自己写`}
                placeholder="写下你想要的"
                maxLength={CUSTOM_MAX}
                value={custom[question.id] ?? ''}
                onChange={(e) => setCustom((old) => ({ ...old, [question.id]: e.target.value }))}
                disabled={busy}
                className="min-h-9 rounded-full bg-glass-strong px-3.5 text-[13.5px] text-ink shadow-edge-strong outline-none placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
              />
            )}
          </fieldset>
        );
      })}
      {active && (
        <CardActions>
          <CardButton
            tone="accent"
            disabled={busy || missing}
            onClick={() => void actions.say('answer', answerText(block, answers))}
          >
            {actions.busy === 'answer' ? '正在发…' : '发送回答'}
          </CardButton>
          {missing && <span className="text-[12px] text-ink-muted">每题选一个再发送</span>}
        </CardActions>
      )}
    </section>
  );
}
