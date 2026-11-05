// 问题卡：几道选择题，默认项已选好，每题都能选「你看着办」，选项都不合适时可以「自己写」。
// 可以只答一部分（没答的按默认）、点「直接开始」，或者说这不是任务。答过的卡片只显示答案。
import {
  AUTO_ANSWER,
  CUSTOM_ANSWER_MAX,
  CUSTOM_ANSWER_PREFIX,
  type QuestionsCard as QuestionsData,
} from '@oasis/contracts/conversation';
import { useState } from 'react';
import { answerIntake, cancelIntake } from '../api/queries.ts';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  Choice,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

const AUTO_LABEL = '你看着办';
const CUSTOM_LABEL = '自己写';

function answerLabel(question: QuestionsData['questions'][number], answer: string | undefined) {
  if (answer === undefined)
    return `${question.options.find((o) => o.id === question.default)?.label ?? ''}（默认）`;
  if (answer === AUTO_ANSWER) return AUTO_LABEL;
  if (answer.startsWith(CUSTOM_ANSWER_PREFIX)) return answer.slice(CUSTOM_ANSWER_PREFIX.length);
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
  /** 选了「自己写」的题目和写的内容 */
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answered = card.answers !== null;
  const busy = actions.busy !== null;
  const chosen = Object.fromEntries(
    Object.entries(picked).map(([id, value]) =>
      value === CUSTOM_ANSWER_PREFIX
        ? [id, `${CUSTOM_ANSWER_PREFIX}${(custom[id] ?? '').trim()}`]
        : [id, value],
    ),
  );
  /** 选了「自己写」却还没写 */
  const unwritten = Object.values(chosen).some((value) => value === CUSTOM_ANSWER_PREFIX);

  const submit = (skip: boolean) =>
    actions.run('answer', () =>
      answerIntake(actions.conversationId, answered ? card.answers! : chosen, skip, messageId),
    );

  if (answered || !active) {
    return (
      <CardFrame speaker={speaker} label="问题卡" dim={!answered}>
        <CardHeading
          kind={`想先问清楚几件事 · 第 ${card.round} 轮`}
          status={<StatusTag>{answered ? '已回答' : '没有回答'}</StatusTag>}
        />
        {answered && <Answered card={card} />}
        {answered && active && (
          <CardActions>
            <CardButton tone="accent" disabled={busy} onClick={() => void submit(false)}>
              {actions.busy === 'answer' ? '正在整理…' : '继续整理'}
            </CardButton>
            <CardButton
              tone="text"
              disabled={busy}
              onClick={() => void actions.run('cancel', () => cancelIntake(actions.conversationId))}
            >
              先不做了
            </CardButton>
          </CardActions>
        )}
      </CardFrame>
    );
  }

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
                <Choice
                  name={name}
                  label={CUSTOM_LABEL}
                  checked={picked[question.id] === CUSTOM_ANSWER_PREFIX}
                  onChange={() => choose(CUSTOM_ANSWER_PREFIX)}
                  disabled={busy}
                />
              </div>
              {picked[question.id] === CUSTOM_ANSWER_PREFIX && (
                <input
                  type="text"
                  autoFocus
                  aria-label={`${question.text}：自己写`}
                  placeholder="写下你想要的"
                  maxLength={CUSTOM_ANSWER_MAX}
                  value={custom[question.id] ?? ''}
                  onChange={(e) => setCustom((old) => ({ ...old, [question.id]: e.target.value }))}
                  disabled={busy}
                  className="min-h-9 rounded-full bg-glass-active px-3.5 text-[13.5px] text-ink shadow-edge-strong outline-none placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
                />
              )}
            </fieldset>
          );
        })}
      </div>
      <CardActions>
        <CardButton tone="accent" onClick={() => void submit(false)} disabled={busy || unwritten}>
          {actions.busy === 'answer' ? '正在整理…' : '好了，继续'}
        </CardButton>
        <CardButton onClick={() => void submit(true)} disabled={busy || unwritten}>
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
      <p className="m-0 text-[12px] text-ink-muted">
        {unwritten
          ? '选了「自己写」的题目还没写内容。'
          : '「直接开始」：不再追问，按现在选的写任务单。'}
      </p>
    </CardFrame>
  );
}
