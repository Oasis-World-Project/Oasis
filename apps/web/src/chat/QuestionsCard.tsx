// 问题卡：几道选择题，默认项已选好，每题都能选「你看着办」。
// 可以只答一部分（没答的按默认）、点「直接开始」，或者说这不是任务。答过的卡片只显示答案。
import { AUTO_ANSWER, type QuestionsCard as QuestionsData } from '@oasis/contracts/conversation';
import { useState } from 'react';
import { answerIntake, cancelIntake } from '../api/queries.ts';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

const AUTO_LABEL = '你看着办';

function answerLabel(question: QuestionsData['questions'][number], answer: string | undefined) {
  if (answer === undefined)
    return `${question.options.find((o) => o.id === question.default)?.label ?? ''}（默认）`;
  if (answer === AUTO_ANSWER) return AUTO_LABEL;
  return question.options.find((o) => o.id === answer)?.label ?? answer;
}

function Answered({ card }: { card: QuestionsData }) {
  return (
    <dl className="m-0 flex flex-col gap-2">
      {card.questions.map((question) => (
        <div key={question.id} className="flex flex-col gap-0.5">
          <dt className="text-[13px] text-ink-muted">{question.text}</dt>
          <dd className="m-0 text-[14px]">{answerLabel(question, card.answers?.[question.id])}</dd>
        </div>
      ))}
    </dl>
  );
}

function Choice({
  name,
  label,
  checked,
  onChange,
  disabled,
  isDefault,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  isDefault?: boolean;
}) {
  return (
    <label
      className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13.5px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
        checked ? 'bg-solid text-on-solid' : 'bg-glass-active text-ink shadow-edge-strong'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      {label}
      {isDefault && <span className={checked ? 'opacity-70' : 'text-ink-muted'}>· 默认</span>}
    </label>
  );
}

export function QuestionsCard({
  messageId,
  card,
  active,
  speaker,
}: {
  messageId: string;
  card: QuestionsData;
  /** 是不是当前要回答的那张（后面还没有 AI 的新消息） */
  active: boolean;
  speaker: Speaker;
}) {
  const actions = useChatActions();
  const [picked, setPicked] = useState<Record<string, string>>(() =>
    Object.fromEntries(card.questions.map((q) => [q.id, q.default])),
  );
  const answered = card.answers !== null;
  const busy = actions.busy !== null;

  if (answered || !active) {
    return (
      <CardFrame speaker={speaker} label="问题卡" dim={!answered}>
        <CardHeading
          kind={`想先问清楚几件事 · 第 ${card.round} 轮`}
          status={<StatusTag>{answered ? '已回答' : '没有回答'}</StatusTag>}
        />
        {answered && <Answered card={card} />}
      </CardFrame>
    );
  }

  const submit = (skip: boolean) =>
    actions.run('answer', () => answerIntake(actions.conversationId, picked, skip));

  return (
    <CardFrame speaker={speaker} label="问题卡" glowing={actions.busy === 'answer'}>
      <CardHeading kind={`想先问清楚几件事 · 第 ${card.round} 轮`} />
      {card.intro && <p className="m-0 text-[14.5px] leading-relaxed">{card.intro}</p>}
      <div className="flex flex-col gap-4">
        {card.questions.map((question) => {
          const name = `${messageId}-${question.id}`;
          const choose = (value: string) => setPicked((old) => ({ ...old, [question.id]: value }));
          return (
            <fieldset key={question.id} className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 p-0 text-[14.5px] font-medium">{question.text}</legend>
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => (
                  <Choice
                    key={option.id}
                    name={name}
                    label={option.label}
                    checked={picked[question.id] === option.id}
                    onChange={() => choose(option.id)}
                    disabled={busy}
                    isDefault={option.id === question.default}
                  />
                ))}
                <Choice
                  name={name}
                  label={AUTO_LABEL}
                  checked={picked[question.id] === AUTO_ANSWER}
                  onChange={() => choose(AUTO_ANSWER)}
                  disabled={busy}
                />
              </div>
            </fieldset>
          );
        })}
      </div>
      <CardActions>
        <CardButton tone="accent" onClick={() => void submit(false)} disabled={busy}>
          {actions.busy === 'answer' ? '正在整理…' : '好了，继续'}
        </CardButton>
        <CardButton onClick={() => void submit(true)} disabled={busy}>
          直接开始
        </CardButton>
        <CardButton
          tone="text"
          onClick={() => void actions.run('cancel', () => cancelIntake(actions.conversationId))}
          disabled={busy}
        >
          不是任务
        </CardButton>
      </CardActions>
      <p className="m-0 text-[12px] text-ink-muted">「直接开始」：不再追问，按现在选的写任务单。</p>
    </CardFrame>
  );
}
