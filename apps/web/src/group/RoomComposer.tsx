// 群页的输入框：上面一行是谁在忙（点它去工作台看）；框里先是要发的文件、引用的群文件、「@谁」胶囊和输入，
// 下面是「＋」「@」和发送。「＋」里上传文件、引用工作台里的文件；「@」弹出「召唤谁来回答」。照原型 ②③。
// 和好友的私聊也用它：没有「@」，「＋」就是发文件。
import type { Mention } from '@oasis/contracts/conversation';
import { MAX_FILE_REFS } from '@oasis/contracts/group';
import { ArrowUp, AtSign, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PendingFiles } from '../chat/Attachments.tsx';
import { badgeOf, baseName } from '../chat/files.ts';
import { useAttachments } from '../chat/use-attachments.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { aiLook } from './people.ts';
import { Popover } from './RoomHeader.tsx';
import { mentionText, useRoom } from './room.ts';
import { fileNote, useClock } from './workbench/files.tsx';

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

const ROUND =
  'flex size-10 cursor-pointer items-center justify-center rounded-full border-0 text-ink shadow-[inset_0_0_0_1px_var(--oasis-track)] disabled:cursor-not-allowed disabled:opacity-45';
const MENU_ITEM =
  'h-11 cursor-pointer rounded-[20px] border-0 bg-transparent px-3 text-left text-sm font-medium text-ink hover:bg-glass-active disabled:cursor-not-allowed disabled:opacity-45';

/** 「＋」弹出的菜单：上传文件、引用工作台里的文件（再点开是群文件的单子） */
function PlusMenu({
  anchor,
  refs,
  task,
  onTask,
  onUpload,
  onRef,
  onClose,
}: {
  anchor: string;
  refs: string[];
  /** 这句话是不是作为任务发布 */
  task: boolean;
  onTask: (next: boolean) => void;
  onUpload: () => void;
  onRef: (path: string) => void;
  onClose: () => void;
}) {
  const room = useRoom();
  const [listing, setListing] = useState(false);
  const now = useClock();
  const files = room.bench.files.filter((file) => !refs.includes(file.path));
  return (
    <Popover
      label="更多"
      role="menu"
      onClose={onClose}
      className={`${anchor} left-[18px] w-[280px] gap-0.5 rounded-pop p-2`}
    >
      {listing ? (
        <>
          <span className="px-3 pb-1 pt-2 text-[12.5px] text-ink-muted">引用哪个文件</span>
          <div className="scroll-quiet flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                role="menuitem"
                onClick={() => onRef(file.path)}
                className="flex cursor-pointer flex-col gap-px rounded-[20px] border-0 bg-transparent px-3 py-2 text-left text-ink hover:bg-glass-active"
              >
                <span className="truncate text-sm font-medium">{file.name}</span>
                <span className="truncate text-xs text-ink-muted">{fileNote(room, file, now)}</span>
              </button>
            ))}
            {files.length === 0 && (
              <span className="px-3 py-2 text-[13px] text-ink-muted">没有别的群文件了。</span>
            )}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={task}
            onClick={() => onTask(!task)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[20px] border-0 bg-transparent px-3 py-2.5 text-left text-ink hover:bg-glass-active"
          >
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">作为任务发布</span>
              <span className="text-xs text-ink-muted">
                没 @ 谁时挑最对口的 AI 出来负责，它可以把一部分交给别的 AI
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-[22px] w-[38px] shrink-0 rounded-full ${task ? 'bg-accent' : 'bg-dot-idle'}`}
            >
              <span
                className={`absolute top-[3px] size-4 rounded-full bg-on-solid shadow-raised ${task ? 'left-[19px]' : 'left-[3px]'}`}
              />
            </span>
          </button>
          <button type="button" role="menuitem" onClick={onUpload} className={MENU_ITEM}>
            上传文件
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!room.bench.files.length || refs.length >= MAX_FILE_REFS}
            title={room.bench.files.length ? undefined : '还没有群文件'}
            onClick={() => setListing(true)}
            className={MENU_ITEM}
          >
            引用工作台里的文件
          </button>
        </>
      )}
    </Popover>
  );
}

/** 输入框上面那行：几个 AI 在忙，谁在旁听；点它去工作台看它们在做什么 */
function BusyLine() {
  const { group, models, bench } = useRoom();
  const busy = group.ais.filter((ai) => ai.runId);
  const idle = group.ais.filter((ai) => !ai.runId);
  if (!busy.length) return null;
  const names = idle.map((ai) => aiLook(models, ai.key).name);
  return (
    <button
      type="button"
      onClick={() => bench.openTasks()}
      className="mx-auto mb-2.5 flex h-[30px] cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent py-0 pl-1.5 pr-3 text-[12.5px] text-ink-muted"
    >
      <span
        aria-hidden="true"
        className="relative h-5 shrink-0"
        style={{ width: (busy.length - 1) * 14 + 20 }}
      >
        {busy.map((ai, index) => {
          const look = aiLook(models, ai.key);
          return (
            <span key={ai.key} className="absolute top-0" style={{ left: index * 14 }}>
              <AiAvatar mono={look.mono} glow={look.glow} size={20} />
            </span>
          );
        })}
      </span>
      {busy.length} 个 AI 在工作台忙{names.length ? `，${names.join('、')} 在旁听` : ''}
    </button>
  );
}

export function RoomComposer({
  mentions,
  onMentions,
  refs,
  onRefs,
}: {
  mentions: Mention[];
  onMentions: (next: Mention[]) => void;
  /** 引用着的群文件（路径） */
  refs: string[];
  onRefs: (next: string[]) => void;
}) {
  const room = useRoom();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // @ 上谁、引用了文件以后（从弹层里挑的、舞台卡片和工作台上点的）光标回到输入框
  useEffect(() => {
    if (mentions.length || refs.length) inputRef.current?.focus();
  }, [mentions, refs]);
  const { group, online, sending } = room;
  const direct = group.kind === 'direct';
  const attachments = useAttachments();
  const [draft, setDraft] = useState('');
  const [task, setTask] = useState(false);
  const [open, setOpen] = useState<'mention' | 'plus' | null>(null);
  const locked = !online || sending;
  // 弹层贴着输入框的上沿：上面有「谁在忙」那一行时盖住它，没有时就在输入框上面
  const anchor = group.ais.some((ai) => ai.runId)
    ? 'bottom-[calc(100%-34px)]'
    : 'bottom-[calc(100%+4px)]';
  const canSend =
    !locked &&
    !attachments.uploading &&
    !attachments.failed &&
    (draft.trim().length > 0 || attachments.ids.length > 0 || refs.length > 0);

  async function send() {
    if (!canSend) return;
    if (await room.send(draft.trim(), mentions, { attachments: attachments.ids, refs, task })) {
      setDraft('');
      setTask(false);
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
      : mentions.length
        ? '说说要它做什么'
        : group.ais.length
          ? '说点什么，或者 @ 一个 AI'
          : '说点什么';

  return (
    <footer className="relative flex flex-col px-[18px] pb-[18px] pt-1">
      <BusyLine />
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
              任务
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
            maxLength={4000}
            disabled={locked}
            autoFocus
            placeholder={placeholder}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              const value = event.target.value;
              // 打一个 @ 就弹出「召唤谁来回答」
              if (!direct && value.endsWith('@') && value.length === draft.length + 1) {
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
            aria-label={direct ? '发文件' : '更多'}
            aria-expanded={direct ? undefined : open === 'plus'}
            disabled={locked}
            onClick={() => (direct ? upload() : setOpen(open === 'plus' ? null : 'plus'))}
            className={`${ROUND} ${open === 'plus' ? 'bg-glass-active' : 'bg-transparent'}`}
          >
            <Plus size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          {!direct && (
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
          <span className="flex-1" />
          <button
            type="button"
            aria-label={task ? '发布任务' : '发送'}
            disabled={!canSend}
            onClick={() => void send()}
            className="flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-accent text-on-accent shadow-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none"
          >
            <ArrowUp size={19} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </footer>
  );
}
