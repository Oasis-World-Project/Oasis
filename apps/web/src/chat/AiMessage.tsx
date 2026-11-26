// AI 在一轮里的一段消息里的内容：它开工前说的话、干活的过程、收工后说的话（话里的问卷、任务单画成卡片），
// 下面是结局（出错、已停下）和这一轮的花费。过程不整段铺在聊天里：收成一行、点开才看（私聊和群里一样）。
// 头像和排版在 group/RoomMessages.tsx。
import type { MessageBody, MessagePart } from '@oasis/contracts/conversation';
import { Info } from 'lucide-react';
import { Fragment, type CSSProperties } from 'react';
import { formatCost } from '../ui/format.ts';
import { splitBlocks } from './blocks.ts';
import { Markdown } from './Markdown.tsx';
import { CardButton } from './parts.tsx';
import { ProcessFold, stepFacts, Todos } from './Process.tsx';
import { QuestionsCard } from './QuestionsCard.tsx';
import { SheetCard } from './SheetCard.tsx';
import { useChatActions } from './use-chat-actions.ts';

type TextMessage = Extract<MessageBody, { kind: 'text' }>;

/**
 * 一条消息分成三段：第一步之前说的话、过程（第一步到最后一步，连同中间边做边说的话）、最后一步之后
 * 说的话。没动过手的消息只有第一段。
 */
function splitProcess(parts: MessagePart[]) {
  const first = parts.findIndex((part) => part.type === 'step');
  if (first < 0) return { before: parts, process: [], after: [] };
  const last = parts.findLastIndex((part) => part.type === 'step');
  return {
    before: parts.slice(0, first),
    process: parts.slice(first, last + 1),
    after: parts.slice(last + 1),
  };
}

/** AI 说的话外面的那层气泡：带它自己的光色（由聊天页给） */
export interface Bubble {
  className: string;
  style?: CSSProperties;
}

/** AI 说的一段话：Markdown，代码块里的问卷和任务单画成卡片 */
function AiText({
  id,
  text,
  active,
  bubble,
}: {
  id: string;
  text: string;
  active: boolean;
  bubble: Bubble;
}) {
  return (
    <>
      {splitBlocks(text).map((block, index) =>
        block.kind === 'text' ? (
          <div
            key={index}
            className={`px-4 py-2.5 [overflow-wrap:anywhere] ${bubble.className}`}
            style={bubble.style}
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

/**
 * AI 一条消息里的内容：开工前说的话、过程（收成一行）、收工后说的话、出错和停下的说明、「继续」、花费。
 * 私聊和群里共用。
 */
export function AiBody({
  message,
  latest,
  bubble,
}: {
  message: TextMessage;
  /** 是最新的一条（后面没有新的话）：问卷能答、任务单能确认、出错了能「继续」 */
  latest: boolean;
  bubble: Bubble;
}) {
  const actions = useChatActions();
  const { parts = [], todos, stopped, spentMicro } = message.data;
  const live = message.status === 'streaming';
  const canContinue =
    latest && !actions.turnActive && (message.status === 'failed' || Boolean(stopped));
  const { before, process, after } = splitProcess(parts);
  const steps = stepFacts(process).count;
  const said = (list: MessagePart[], offset: number) =>
    list.map((part, index) => (
      <Fragment key={offset + index}>
        {part.type === 'text' ? (
          <AiText
            id={`${message.id}-${offset + index}`}
            text={part.text}
            active={latest}
            bubble={bubble}
          />
        ) : part.type === 'notice' ? (
          <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-ink-muted">
            <Info size={13} aria-hidden="true" />
            {part.text}
          </p>
        ) : null}
      </Fragment>
    ));
  return (
    <>
      {said(before, 0)}
      {parts.length === 0 && live && <span className="text-ink-muted">正在想…</span>}
      {steps > 0 && <ProcessFold parts={process} todos={todos} live={live} />}
      {steps === 0 && todos && todos.length > 0 && <Todos items={todos} live={live} />}
      {said(after, before.length + process.length)}
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
    </>
  );
}
