// 聊天页的输入框（群、好友、和 AI 的私聊同一个）。照原型 ②③：框里先是要发的文件、引用的群文件、「@谁」胶囊
// 和输入，下面一排是「＋」「@」、这段对话在哪干活、手动 / 自动、联网搜索，最右是发送。
// 群里：上面一行是谁在忙（点它去工作台看）；「＋」里作为任务发布、上传文件、引用工作台里的文件；「@」弹出
// 「召唤谁来回答」。和 AI 的私聊：上面是等你点的确认卡和排着队的话；它在干活、框里没字时，发送键就是停下。
// 和好友的私聊：没有「@」，「＋」就是发文件。和 AI 的私聊：「＋」里是「在云端做」和上传文件。
import type { Mention } from '@oasis/contracts/conversation';
import { ArrowUp, AtSign, Plus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { PendingFiles } from '../chat/Attachments.tsx';
import { ConfirmationCards } from '../chat/ConfirmationCards.tsx';
import { badgeOf, baseName } from '../chat/files.ts';
import { HomeBar, type Home } from '../chat/HomeBar.tsx';
import { QueuedMessages } from '../chat/QueuedMessages.tsx';
import type { useAttachments } from '../chat/use-attachments.ts';
import { useChatActions } from '../chat/use-chat-actions.ts';
import { WebToggle } from '../chat/WebToggle.tsx';
import { BusyLine, PlusMenu, ROUND } from './ComposerMenus.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { aiLook, working } from './people.ts';
import { mentionText, useRoom } from './room.ts';
import { VaultEmpty } from './Vault.tsx';

const sameMention = (a: Mention, b: Mention) =>
  a.kind === b.kind &&
  (a.kind === 'all' ||
    (a.kind === 'ai' && b.kind === 'ai' && a.key === b.key) ||
    (a.kind === 'user' && b.kind === 'user' && a.userId === b.userId));

/** 再 @ 一个：已经 @ 过的不重复；@ 了全体 AI 就不用再单独 @ 某个 AI */
export function addMention(list: Mention[], mention: Mention): Mention[] {
  if (list.some((item) => sameMention(item, mention))) return list;
  if (mention.kind === 'all') return [...list.filter((item) => item.kind !== 'ai'), mention];
  if (mention.kind === 'ai' && list.some((item) => item.kind === 'all')) return list;
  return [...list, mention];
}

/** 和 AI 的私聊，输入框上面：等你点的确认卡、排着队的话（拿回来改的放回输入框） */
function DmQueue({ onEdit }: { onEdit: (text: string) => void }) {
  const room = useRoom();
  const { group } = room;
  const queued = useMemo(
    () => group.messages.filter((m) => m.kind === 'text' && m.data.pending),
    [group.messages],
  );
  if (!group.confirmations.length && !queued.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      <ConfirmationCards
        conversationId={group.id}
        cards={group.confirmations}
        messages={group.messages}
        onDecided={() => void room.refresh()}
      />
      <QueuedMessages messages={queued} onEdit={onEdit} />
    </div>
  );
}

/** 和 AI 的私聊：它在干活、框里没字时，发送键换成停下 */
function StopButton() {
  const actions = useChatActions();
  return (
    <button
      type="button"
      aria-label="停下"
      title="停下这一轮：已经做出来的留着，说「继续」接着做"
      disabled={actions.busy !== null}
      onClick={() => void actions.stop()}
      className="flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-solid text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
    >
      <Square size={15} fill="currentColor" aria-hidden="true" />
    </button>
  );
}

export function RoomComposer({
  inputRef,
  hint,
  onSent,
  attachments,
  mentions,
  onMentions,
  refs,
  onRefs,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 卡片要求的提示（如「说说要改哪里」） */
  hint: string | null;
  /** 发出去了：提示清掉 */
  onSent: () => void;
  /** 要发的文件（拖进聊天窗的也加在这里） */
  attachments: ReturnType<typeof useAttachments>;
  mentions: Mention[];
  onMentions: (next: Mention[]) => void;
  /** 引用着的群文件（路径） */
  refs: string[];
  onRefs: (next: string[]) => void;
}) {
  const room = useRoom();
  const fileRef = useRef<HTMLInputElement>(null);
  // @ 上谁、引用了文件以后（从弹层里挑的、舞台卡片和工作台上点的）光标回到输入框
  useEffect(() => {
    if (mentions.length || refs.length) inputRef.current?.focus();
  }, [mentions, refs, inputRef]);
  const { group, online, sending } = room;
  const scene = group.kind;
  const ai = scene === 'dm' ? group.ais[0] : undefined;
  const turnActive = Boolean(ai?.runId);
  const [draft, setDraft] = useState('');
  const [task, setTask] = useState(false);
  const [open, setOpen] = useState<'mention' | 'plus' | null>(null);
  const locked = !online || sending;
  // 弹层贴着输入框的上沿：上面有「谁在忙」那一行时盖住它，没有时就在输入框上面
  const anchor =
    scene === 'group' && group.ais.some(working)
      ? 'bottom-[calc(100%-34px)]'
      : 'bottom-[calc(100%+4px)]';
  const hasFiles = attachments.ids.length > 0 || attachments.files.length > 0;
  const hasText = draft.trim().length > 0;
  const canSend =
    !locked &&
    !attachments.uploading &&
    !attachments.failed &&
    // 和 AI 的私聊：一句话要有字；文件只能在一轮开始时交给它
    (scene === 'dm'
      ? hasText && !(turnActive && hasFiles && !task)
      : hasText || attachments.ids.length > 0 || refs.length > 0);
  const home: Home | undefined =
    scene === 'dm' && group.home
      ? { id: group.id, setup: group.home, onSaved: () => void room.refresh() }
      : undefined;

  async function send() {
    if (!canSend) return;
    if (await room.send(draft.trim(), mentions, { attachments: attachments.ids, refs, task })) {
      setDraft('');
      setTask(false);
      onSent();
      onMentions([]);
      onRefs([]);
      attachments.clear();
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法选字时按回车不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }
  function pick(mention: Mention) {
    onMentions(addMention(mentions, mention));
    setOpen(null);
  }
  const upload = () => {
    setOpen(null);
    fileRef.current?.click();
  };
  const placeholder = sending
    ? '发送中…'
    : task
      ? '说说要做成什么样'
      : hint
        ? hint
        : mentions.length
          ? '说说要它做什么'
          : scene === 'dm'
            ? turnActive
              ? hasFiles
                ? '带文件的话等它做完再发，或者先停下这一轮'
                : '它在做：你说的话先排着'
              : hasFiles
                ? '说说要拿这些文件做什么'
                : '说点什么'
            : group.ais.length
              ? '说点什么，或者 @ 一个 AI'
              : '说点什么';

  return (
    <footer className="relative flex flex-col px-[18px] pb-[18px] pt-1">
      <VaultEmpty />
      {scene === 'group' && <BusyLine />}
      {scene === 'dm' && (
        <DmQueue
          onEdit={(text) => {
            setDraft((current) => (current.trim() ? `${text}\n${current}` : text));
            inputRef.current?.focus();
          }}
        />
      )}
      {open === 'mention' && (
        <MentionPicker anchor={anchor} onPick={pick} onClose={() => setOpen(null)} />
      )}
      {open === 'plus' && (
        <PlusMenu
          anchor={anchor}
          refs={refs}
          task={task}
          onTask={setTask}
          onUpload={upload}
          onRef={(path) => {
            onRefs([...refs, path]);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        aria-label="选择要发的文件"
        onChange={(event) => {
          attachments.add(event.target.files ?? []);
          event.target.value = '';
        }}
      />
      <div className="glass-composer flex flex-col gap-2 rounded-pop pb-2.5 pl-[18px] pr-3 pt-3">
        {(attachments.files.length > 0 || refs.length > 0) && (
          <div className="flex flex-col gap-1.5">
            <PendingFiles files={attachments.files} onRemove={attachments.remove} />
            {attachments.notice && (
              <p role="alert" className="m-0 text-xs text-accent">
                {attachments.notice}
              </p>
            )}
            {refs.length > 0 && (
              <ul aria-label="引用的群文件" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {refs.map((path) => (
                  <li
                    key={path}
                    className="flex h-9 max-w-[240px] items-center gap-2 rounded-full bg-glass-strong pl-1.5 pr-1 shadow-edge-strong"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-solid font-display text-[7.5px] font-medium text-on-solid"
                    >
                      {badgeOf(path)}
                    </span>
                    <span className="truncate text-[12.5px] font-medium">{baseName(path)}</span>
                    <button
                      type="button"
                      aria-label={`不引用 ${baseName(path)}`}
                      onClick={() => onRefs(refs.filter((item) => item !== path))}
                      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {task && (
            <span className="h-7 shrink-0 rounded-full bg-solid px-2.5 text-[12.5px] font-medium leading-7 text-on-solid">
              {scene === 'dm' ? '在云端做' : '任务'}
            </span>
          )}
          {mentions.map((mention, index) => (
            <span
              key={index}
              className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-full bg-accent-tint pl-2.5 pr-1 text-[13.5px] font-medium text-accent-ink"
            >
              @{mentionText(room, mention)}
              <button
                type="button"
                aria-label={`取消 @${mentionText(room, mention)}`}
                onClick={() => onMentions(mentions.filter((_, i) => i !== index))}
                className="flex size-[22px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-accent-ink"
              >
                <X size={11} strokeWidth={2.8} aria-hidden="true" />
              </button>
            </span>
          ))}
          <textarea
            aria-label="消息"
            ref={inputRef}
            rows={1}
            value={draft}
            maxLength={scene === 'dm' ? 8000 : 4000}
            disabled={locked}
            autoFocus
            placeholder={placeholder}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              // 粘贴进来的文件（截图、复制的文件）加到要发的文件里
              if (event.clipboardData.files.length > 0) {
                event.preventDefault();
                attachments.add(event.clipboardData.files);
              }
            }}
            onChange={(event) => {
              const value = event.target.value;
              // 打一个 @ 就弹出「召唤谁来回答」
              if (scene === 'group' && value.endsWith('@') && value.length === draft.length + 1) {
                setOpen('mention');
                return;
              }
              setDraft(value);
            }}
            className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-[1_1_200px] resize-none overflow-y-auto border-0 bg-transparent py-1 text-[15px] leading-normal text-ink outline-none placeholder:text-ink-muted"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={scene === 'direct' ? '发文件' : '更多'}
            aria-expanded={scene === 'direct' ? undefined : open === 'plus'}
            disabled={locked}
            onClick={() =>
              scene === 'direct' ? upload() : setOpen(open === 'plus' ? null : 'plus')
            }
            className={`${ROUND} ${open === 'plus' ? 'bg-glass-active' : 'bg-transparent'}`}
          >
            <Plus size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          {scene === 'group' && (
            <button
              type="button"
              aria-label="召唤某个 AI 或某人"
              aria-expanded={open === 'mention'}
              onClick={() => setOpen(open === 'mention' ? null : 'mention')}
              className={`${ROUND} ${open === 'mention' ? 'bg-glass-active' : 'bg-transparent'}`}
            >
              <AtSign size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {home && ai && (
            <>
              <WebToggle home={home} />
              <HomeBar
                home={home}
                name={aiLook(room.models, ai.key, group.title).name}
                fresh={group.messages.length === 0 && !turnActive}
                turnActive={turnActive}
              />
            </>
          )}
          <span className="flex-1" />
          {scene === 'dm' && turnActive && !hasText ? (
            <StopButton />
          ) : (
            <button
              type="button"
              aria-label={task ? (scene === 'dm' ? '派到云端' : '发布任务') : '发送'}
              disabled={!canSend}
              onClick={() => void send()}
              className="flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-accent text-on-accent shadow-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
            >
              <ArrowUp size={19} strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
