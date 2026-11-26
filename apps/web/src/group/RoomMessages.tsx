// 聊天里的消息（群、好友、和 AI 的私聊同一套）。照原型 ②：每句话都有头像和名字，别人的在左、我的在右；
// 时间分隔、话带的文件、AI 的话（气泡带它的光色；干活的过程收成一行，点开看）、任务（和工作台里是同一条）。
// 群里 @ 了的 AI 还在忙时，话下面写着它忙完就看，可以「现在告诉它」。和 AI 的私聊里排着队还没交给它的话
// 不在这里（在输入框上面），开新话题的地方有一条分隔。
import type { Mention, MessageArtifact, MessageAttachment } from '@oasis/contracts/conversation';
import type { GroupAi, GroupMessage } from '@oasis/contracts/group';
import { Link } from '@tanstack/react-router';
import { PencilLine } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { groupAttachmentUrl, steerGroupMessage } from '../api/queries.ts';
import { uploadUrl } from '../api/upload.ts';
import { AiBody } from '../chat/AiMessage.tsx';
import { FileChip } from '../chat/FileChip.tsx';
import { FilePreview, type PreviewFile } from '../chat/FilePreview.tsx';
import { MessageText } from '../chat/MessageText.tsx';
import { ChatActionsContext } from '../chat/use-chat-actions.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { actionsFor } from './ai-actions.ts';
import { AssignProgress } from './AssignProgress.tsx';
import { MemberAvatar } from './Members.tsx';
import { aiLook, DIVIDER_GAP_MS, dividerText } from './people.ts';
import { mentionText, uploadPath, useRoom } from './room.ts';
import { FilePill } from './workbench/files.tsx';
import { tasksOf } from './workbench/tasks.ts';
import { TaskRow } from './workbench/TasksTab.tsx';

type TextMessage = Extract<GroupMessage, { kind: 'text' }>;

/** 一句话的排版：头像在上角，旁边一行名字，下面是内容；我的靠右 */
function Row({
  mine = false,
  avatar,
  name,
  note,
  children,
}: {
  mine?: boolean;
  avatar: ReactNode;
  name: string;
  /** 名字旁边的小字（插话、任务） */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`flex items-start gap-2.5 ${mine ? 'flex-row-reverse' : ''}`}>
      {avatar}
      <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${mine ? 'items-end' : 'items-start'}`}>
        <span className="flex items-center gap-2 px-1 text-xs text-ink-muted">
          <span className="font-medium text-ink">{name}</span>
          {note}
        </span>
        {children}
      </div>
    </div>
  );
}

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

/**
 * 一句话带的文件、引用的群文件。群里发的文件就是群文件，点开在工作台看（看到的是现在最新的那一版）；
 * 私聊里文件只跟着这条消息，点开弹出预览。
 */
function MessageFiles({ message, mine }: { message: TextMessage; mine: boolean }) {
  const { group } = useRoom();
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const attachments = message.data.attachments ?? [];
  const refs = message.data.refs ?? [];
  if (!attachments.length && !refs.length) return null;
  // 和好友的私聊里文件跟着这个聊天，和 AI 的私聊里是我自己传的
  const urlOf = (id: string, download?: boolean) =>
    group.kind === 'direct' ? groupAttachmentUrl(group.id, id, download) : uploadUrl(id, download);
  const toPreview = (file: MessageAttachment): PreviewFile => ({
    path: file.name,
    size: file.size,
    url: urlOf(file.id),
    downloadUrl: urlOf(file.id, true),
  });
  return (
    <>
      <ul
        aria-label="带的文件"
        className={`m-0 flex w-full max-w-[320px] list-none flex-col gap-1.5 p-0 ${mine ? 'items-end' : 'items-start'}`}
      >
        {group.kind !== 'group'
          ? attachments.map((file) => (
              <FileChip
                key={file.id}
                file={toPreview(file)}
                onOpen={() => setPreview(toPreview(file))}
              />
            ))
          : [
              ...attachments.map((file) => ({ path: uploadPath(file.name), name: file.name })),
              ...refs,
            ].map((file, index) => (
              <li key={index} className="flex max-w-full">
                <FilePill path={file.path} name={file.name} />
              </li>
            ))}
      </ul>
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/** 「让 AI 改」时带上的成果：点开回到画布里的这份成果 */
function RevisedArtifacts({ artifacts }: { artifacts: MessageArtifact[] }) {
  return (
    <ul aria-label="要改的成果" className="m-0 flex list-none flex-wrap justify-end gap-1.5 p-0">
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

function UserMessage({ message, unseen }: { message: TextMessage; unseen: boolean }) {
  const { group, me, owner, models, busy, act } = useRoom();
  const mine = message.authorId === me;
  const mentions = message.data.mentions ?? [];
  const waiting = waitingFor(message, group.ais);
  // 只发了文件、没写字，也没 @ 谁：不画空气泡
  const said = message.content.length > 0 || mentions.length > 0;
  // 对全体说的话（@ 了全体，或作为任务发布）：写明挑了谁先出来负责
  const { task, lead, interjection, artifacts = [] } = message.data;
  const note = (task || lead || interjection) && (
    <span>
      {[
        task ? '任务' : '',
        lead ? `由 ${aiLook(models, lead).name} 先出来负责` : '',
        // 私聊里的插话：送进去了，AI 做完手上这一步才看
        interjection ? (unseen ? '插话 · AI 做完手上这一步就会看到' : '插话') : '',
      ]
        .filter(Boolean)
        .join(' · ')}
    </span>
  );
  return (
    <Row
      mine={mine}
      name={message.displayName}
      note={note}
      avatar={
        <MemberAvatar
          member={{
            userId: message.authorId,
            displayName: message.displayName,
            avatarVersion:
              group.members.find((member) => member.userId === message.authorId)?.avatarVersion ??
              0,
          }}
          size={30}
        />
      }
    >
      {said && (
        <div
          className={`m-0 max-w-[min(460px,100%)] whitespace-pre-wrap break-words px-4 py-2.5 text-[14.5px] leading-[1.65] ${
            mine ? 'bubble-out bg-solid text-on-solid' : 'bubble-in bg-bubble shadow-edge-strong'
          }`}
        >
          <Mentions mentions={mentions} mine={mine} />
          <MessageText content={message.content} />
        </div>
      )}
      {artifacts.length > 0 && <RevisedArtifacts artifacts={artifacts} />}
      <MessageFiles message={message} mine={mine} />
      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-xs text-ink-muted">
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
      )}
    </Row>
  );
}

function AiSays({ message, latest }: { message: TextMessage; latest: boolean }) {
  const { models } = useRoom();
  const look = aiLook(models, message.authorId, message.displayName);
  return (
    <Row
      name={look.name}
      avatar={
        <AiAvatar
          mono={look.mono}
          glow={look.glow}
          size={30}
          glowing={message.status === 'streaming'}
        />
      }
    >
      <div className="flex min-w-0 max-w-[min(520px,100%)] flex-col gap-2 text-[14.5px] leading-[1.65]">
        <AiBody
          message={message}
          latest={latest}
          bubble={{
            className: 'bubble-in shadow-bubble-edge',
            style: { background: `color-mix(in srgb, ${look.glow} 14%, transparent)` },
          }}
        />
      </div>
    </Row>
  );
}

/**
 * 聊天里的一个任务：和工作台「任务」里是同一条（点开弹出它的窗：成果、过程），下面是它交的文件（点开在
 * 工作台预览）。
 */
function TaskStrip({ message }: { message: Extract<GroupMessage, { kind: 'task' }> }) {
  const { bench } = useRoom();
  const card = message.data;
  // 工作台上已经有这个任务就用那一条（带着过程）；太早的任务工作台没读到，就按这张卡拼
  const task = useMemo(
    () => bench.tasks.find((item) => item.runId === card.runId) ?? tasksOf([message])[0],
    [bench.tasks, card.runId, message],
  );
  return (
    <div className="flex flex-col gap-2 pl-10">
      {task && (
        <div className="max-w-[min(520px,100%)]">
          <TaskRow task={task} onOpen={() => bench.openTasks(card.runId)} />
        </div>
      )}
      {card.files.length > 0 && (
        <ul aria-label="交出的文件" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {card.files.map((file) => (
            <li key={file.artifactId} className="flex max-w-full">
              <FilePill path={file.path} name={file.name} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoomMessages({ hasOlder, onOlder }: { hasOlder: boolean; onOlder: () => void }) {
  const room = useRoom();
  const { group, busy } = room;
  // 私聊里排着队、还没交给 AI 的话不在聊天里（在输入框上面），交给它时才进来
  const messages = useMemo(
    () => group.messages.filter((m) => !(m.kind === 'text' && m.data.pending)),
    [group.messages],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toBottom = useStickToBottom(scroller, content);
  // 自己刚发了一句：不管翻到哪都回到底部
  const last = messages.at(-1);
  const mine = last?.role === 'user' && last.authorId === room.me ? last.id : undefined;
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!mine || followed.current === mine) return;
    followed.current = mine;
    toBottom();
  }, [mine, toBottom]);
  // 每个 AI 最新的一条话：只有它能答问卷、点「继续」；开了新话题，之前的都不算最新。
  // 和 AI 的私聊里后面有了新的话（我的或它的）就不算：问卷答过了、任务单确认过了
  const latest = useMemo(() => {
    const last = new Map<string, string>();
    for (const message of messages) {
      if (message.kind === 'topic' || (group.kind === 'dm' && message.kind === 'text'))
        last.clear();
      if (message.kind === 'text' && message.role === 'assistant')
        last.set(message.authorId, message.id);
    }
    return new Set(last.values());
  }, [messages, group.kind]);
  const actions = useMemo(
    () => new Map(group.ais.map((ai) => [ai.key, actionsFor(room, ai.key)])),
    [group.ais, room],
  );
  const now = new Date();
  // 消息区是 relative：消息里绝对定位的东西以它为定位基准，跟着它裁剪和滚动（私聊页同样的处理）
  return (
    <div
      ref={scroller}
      className="fade-top scroll-quiet relative min-h-0 flex-1 overflow-y-auto px-7 pb-2 pt-1"
    >
      <div
        ref={content}
        aria-label="消息记录"
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
        {!messages.length && (
          <p className="m-0 pt-10 text-center text-[13px] leading-[1.8] text-ink-muted">
            {group.kind === 'dm' ? (
              <>
                打个招呼，或者直接说要做什么：写文档、做图、做视频、做网页都行。
                <br />
                可以附上文件；它做的时候你说的话先排着，点「引导」它马上就看到，也可以随时让它停下。
              </>
            ) : group.ais.length ? (
              '说点什么，或者 @ 一个 AI 让它帮忙。'
            ) : (
              '发一句话，开始聊天。'
            )}
          </p>
        )}
        {messages.map((message, index) => {
          const at = new Date(message.createdAt);
          const previous = messages[index - 1];
          const divider =
            !previous || at.getTime() - Date.parse(previous.createdAt) > DIVIDER_GAP_MS;
          return (
            <Fragment key={message.id}>
              {divider && (
                <div className="text-center text-xs text-ink-muted">{dividerText(at, now)}</div>
              )}
              {message.kind === 'topic' ? (
                <div
                  role="separator"
                  className="flex items-center gap-3 py-1 text-xs text-ink-muted"
                >
                  <span className="h-px flex-1 bg-hairline" />
                  {/* 「开了新话题」或「换到你的电脑（…）干活，开了新话题」 */}
                  <span className="max-w-[70%] text-center">
                    {message.content} · AI 从这里起不记得之前的事
                  </span>
                  <span className="h-px flex-1 bg-hairline" />
                </div>
              ) : message.kind === 'task' ? (
                <TaskStrip message={message} />
              ) : message.kind === 'assign' ? (
                <AssignProgress
                  card={message.data}
                  authorId={message.authorId}
                  name={message.displayName}
                />
              ) : message.role === 'user' ? (
                <UserMessage
                  message={message}
                  // AI 看到插话才在它后面接着写：前面那段还在写、后面还没有它的话，就是还没看到
                  unseen={
                    messages
                      .slice(0, index)
                      .some((m) => m.role === 'assistant' && m.status === 'streaming') &&
                    !messages
                      .slice(index + 1)
                      .some((m) => m.role === 'assistant' && m.kind === 'text')
                  }
                />
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
