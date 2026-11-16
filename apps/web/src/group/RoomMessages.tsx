// 群里的消息：时间分隔、别人的话（左，头像加名字）、我的话（右，墨色）、AI 的话（左，气泡带它的光色，
// 里面是说的话和折叠的步骤）、任务卡。@ 了的 AI 还在忙时，话下面写着它忙完就看，可以「现在告诉它」。照原型 ②。
import type { Mention, TaskCard } from '@oasis/contracts/conversation';
import type { GroupAi, GroupMessage } from '@oasis/contracts/group';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { steerGroupMessage, stopGroupAi } from '../api/queries.ts';
import { AiBody } from '../chat/AiMessage.tsx';
import { CardFrame, CardHeading, StatusTag } from '../chat/parts.tsx';
import { TASK_STATUS, TaskFacts } from '../chat/TaskCard.tsx';
import { ChatActionsContext, type ChatActions } from '../chat/use-chat-actions.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { MemberAvatar } from './Members.tsx';
import { aiLook, DIVIDER_GAP_MS, dividerText } from './people.ts';
import { mentionText, useRoom, type Room } from './room.ts';

type TextMessage = Extract<GroupMessage, { kind: 'text' }>;

/** 这句话 @ 了的 AI 里，还在忙、没看到这句的 */
function waitingFor(message: TextMessage, ais: GroupAi[]): GroupAi[] {
  const mentions = message.data.mentions ?? [];
  const everyone = mentions.some((m) => m.kind === 'all');
  const keys = new Set(mentions.flatMap((m) => (m.kind === 'ai' ? [m.key] : [])));
  return ais.filter(
    (ai) => (everyone || keys.has(ai.key)) && ai.runId && ai.heardSeq < message.seq,
  );
}

function Mentions({ mentions, mine }: { mentions: Mention[]; mine: boolean }) {
  const room = useRoom();
  if (!mentions.length) return null;
  return (
    <span className={`font-medium ${mine ? 'text-accent-soft' : 'text-accent-ink'}`}>
      {mentions.map((m) => `@${mentionText(room, m)}`).join(' ')}{' '}
    </span>
  );
}

function UserMessage({ message }: { message: TextMessage }) {
  const { group, me, owner, models, busy, act } = useRoom();
  const mine = message.authorId === me;
  const mentions = message.data.mentions ?? [];
  const waiting = waitingFor(message, group.ais);
  const hint = waiting.length > 0 && (
    <div
      className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1.5 text-xs text-ink-muted ${
        mine ? 'justify-end' : ''
      }`}
    >
      {waiting.map((ai) => (
        <span key={ai.key} className="flex items-center gap-1.5">
          {aiLook(models, ai.key).name} 在忙，忙完就看
          {(mine || owner) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => steerGroupMessage(group.id, message.id, ai.key))}
              className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-ink underline underline-offset-4 disabled:opacity-45"
            >
              现在告诉它
            </button>
          )}
        </span>
      ))}
    </div>
  );
  if (mine)
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="bubble-out m-0 max-w-[460px] whitespace-pre-wrap break-words bg-solid px-4 py-2.5 text-[14.5px] leading-[1.65] text-on-solid">
          <Mentions mentions={mentions} mine />
          {message.content}
        </p>
        {hint}
      </div>
    );
  return (
    <div className="flex items-end gap-2.5">
      <MemberAvatar
        member={{
          userId: message.authorId,
          displayName: message.displayName,
          avatarVersion:
            group.members.find((member) => member.userId === message.authorId)?.avatarVersion ?? 0,
        }}
        size={30}
      />
      <div className="flex min-w-0 flex-col items-start gap-[3px]">
        <span className="pl-1.5 text-xs text-ink-muted">{message.displayName}</span>
        <p className="bubble-in m-0 max-w-[440px] whitespace-pre-wrap break-words bg-bubble px-4 py-2.5 text-[14.5px] leading-[1.65] shadow-edge-strong">
          <Mentions mentions={mentions} mine={false} />
          {message.content}
        </p>
        {hint}
      </div>
    </div>
  );
}

/** AI 的话里能做的事（答问卷、确认任务单、「继续」）在群里都是 @ 着它发一句话；停下是停它这一轮 */
function actionsFor(room: Room, key: string): ChatActions {
  const { group } = room;
  return {
    conversationId: group.id,
    busy: room.sending || room.busy ? 'send' : null,
    error: null,
    turnActive: Boolean(group.ais.find((ai) => ai.key === key)?.runId),
    say: (_name, content) => room.send(content, [{ kind: 'ai', key }]),
    steer: async () => undefined,
    unqueue: async () => false,
    stop: async () => {
      await room.act(() => stopGroupAi(group.id, key));
    },
    focusComposer: () => room.mention({ kind: 'ai', key }),
  };
}

function AiSays({ message, latest }: { message: TextMessage; latest: boolean }) {
  const { models } = useRoom();
  const look = aiLook(models, message.authorId, message.displayName);
  return (
    <div className="flex items-end gap-2.5">
      <AiAvatar
        mono={look.mono}
        glow={look.glow}
        size={30}
        glowing={message.status === 'streaming'}
      />
      <div className="flex min-w-0 flex-col items-start gap-[3px]">
        <span className="pl-1.5 text-xs text-ink-muted">{look.name}</span>
        <div className="flex min-w-0 max-w-[500px] flex-col gap-2 text-[14.5px] leading-[1.65]">
          <AiBody
            message={message}
            latest={latest}
            bubble={{
              className: 'bubble-in shadow-bubble-edge',
              style: { background: `color-mix(in srgb, ${look.glow} 14%, transparent)` },
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** 群里一个 AI 这一轮的任务卡：任务名、状态、用时、花费、交了哪些文件（打开文件在工作台，之后的阶段做） */
function RoomTask({ card, authorId, name }: { card: TaskCard; authorId: string; name: string }) {
  const { models } = useRoom();
  const status = TASK_STATUS[card.status];
  return (
    <CardFrame
      speaker={aiLook(models, authorId, name)}
      label="任务"
      glowing={card.status === 'running'}
    >
      <CardHeading
        kind={`${aiLook(models, authorId, name).name} 的任务`}
        title={card.title}
        status={<StatusTag tone={status.tone}>{status.label}</StatusTag>}
      />
      <TaskFacts card={card} />
      {card.files.length > 0 && (
        <ul aria-label="交出的文件" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {card.files.map((file) => (
            <li
              key={file.artifactId}
              className="rounded-full bg-glass-active px-3 py-1.5 text-[12.5px] shadow-edge-strong"
            >
              {file.name}
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

export function RoomMessages({ hasOlder, onOlder }: { hasOlder: boolean; onOlder: () => void }) {
  const room = useRoom();
  const { group, busy } = room;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toBottom = useStickToBottom(scroller, content);
  // 自己刚发了一句：不管翻到哪都回到底部
  const last = group.messages.at(-1);
  const mine = last?.role === 'user' && last.authorId === room.me ? last.id : undefined;
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!mine || followed.current === mine) return;
    followed.current = mine;
    toBottom();
  }, [mine, toBottom]);
  // 每个 AI 最新的一条话：只有它能答问卷、点「继续」
  const latest = useMemo(() => {
    const last = new Map<string, string>();
    for (const message of group.messages)
      if (message.kind === 'text' && message.role === 'assistant')
        last.set(message.authorId, message.id);
    return new Set(last.values());
  }, [group.messages]);
  const actions = useMemo(
    () => new Map(group.ais.map((ai) => [ai.key, actionsFor(room, ai.key)])),
    [group.ais, room],
  );
  const now = new Date();
  // 消息区是 relative：问卷卡里视觉隐藏的单选框（sr-only 是绝对定位）以它为定位基准，跟着它裁剪和滚动；
  // 不然单选框排在整页的最底下，选一下浏览器就把整页滚过去、多出一根滚动条（私聊页同样的处理）
  return (
    <div
      ref={scroller}
      className="fade-top scroll-quiet relative min-h-0 flex-1 overflow-y-auto px-7 pb-2 pt-1"
    >
      <div
        ref={content}
        aria-label="群消息记录"
        role="log"
        className="mx-auto flex max-w-[720px] flex-col gap-3.5 pt-2.5"
      >
        {hasOlder && (
          <button
            type="button"
            disabled={busy}
            onClick={onOlder}
            className="h-8 cursor-pointer self-center rounded-full border-0 bg-well px-4 text-xs text-ink disabled:opacity-45"
          >
            查看更早消息
          </button>
        )}
        {!group.messages.length && (
          <p className="m-0 pt-10 text-center text-[13px] text-ink-muted">
            {group.ais.length ? '说点什么，或者 @ 一个 AI 让它帮忙。' : '发一句话，开始聊天。'}
          </p>
        )}
        {group.messages.map((message, index) => {
          const at = new Date(message.createdAt);
          const previous = group.messages[index - 1];
          const divider =
            !previous || at.getTime() - Date.parse(previous.createdAt) > DIVIDER_GAP_MS;
          return (
            <Fragment key={message.id}>
              {divider && (
                <div className="text-center text-xs text-ink-muted">{dividerText(at, now)}</div>
              )}
              {message.kind === 'task' ? (
                <RoomTask
                  card={message.data}
                  authorId={message.authorId}
                  name={message.displayName}
                />
              ) : message.kind !== 'text' ? null : message.role === 'user' ? (
                <UserMessage message={message} />
              ) : (
                <ChatActionsContext.Provider
                  value={actions.get(message.authorId) ?? actionsFor(room, message.authorId)}
                >
                  <AiSays message={message} latest={latest.has(message.id)} />
                </ChatActionsContext.Provider>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
