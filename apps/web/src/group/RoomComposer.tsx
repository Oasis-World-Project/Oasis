// 群页的输入框：上面一行是谁在忙；框里先是「@谁」胶囊和输入，下面是「＋」「@」和发送。
// 「@」弹出「召唤谁来回答」：全体 AI、每个 AI（在忙 / 有空）、也可以叫人。照原型 ②③。
import type { Mention } from '@oasis/contracts/conversation';
import { ArrowUp, AtSign, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AiAvatar, PersonAvatar } from '../ui/Avatar.tsx';
import { aiLook, toneOf } from './people.ts';
import { Popover } from './RoomHeader.tsx';
import { mentionText, useRoom } from './room.ts';

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

function MentionPicker({
  onPick,
  onClose,
}: {
  onPick: (mention: Mention) => void;
  onClose: () => void;
}) {
  const { group, me, models } = useRoom();
  const people = group.members.filter((member) => member.userId !== me);
  return (
    <Popover
      label="召唤谁"
      role="listbox"
      onClose={onClose}
      className="bottom-[calc(100%-34px)] left-[18px] w-[500px] max-w-[calc(100%-36px)] gap-3.5 rounded-[30px] p-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-medium">召唤谁来回答</span>
        {group.ais.length > 0 && (
          <button
            type="button"
            role="option"
            aria-selected="false"
            onClick={() => onPick({ kind: 'all' })}
            className="h-8 cursor-pointer rounded-full border-0 bg-accent-tint px-3.5 text-[12.5px] font-medium text-accent-ink"
          >
            全体 AI
          </button>
        )}
      </div>
      {group.ais.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {group.ais.map((ai) => {
            const look = aiLook(models, ai.key);
            return (
              <button
                key={ai.key}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => onPick({ kind: 'ai', key: ai.key })}
                className="flex w-[86px] cursor-pointer flex-col items-center gap-1.5 rounded-[22px] border-0 bg-bubble pb-2.5 pt-3 text-ink shadow-edge-bright"
              >
                <AiAvatar mono={look.mono} glow={look.glow} size={40} glowing={Boolean(ai.runId)} />
                <span className="max-w-full truncate px-1 text-[13px] font-medium">
                  {look.name}
                </span>
                <span className="text-[11px] text-ink-muted">{ai.runId ? '在忙' : '有空'}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className="text-[13px] text-ink-muted">群里还没有 AI</span>
      )}
      {people.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-muted">也可以叫人</span>
          {people.map((member) => (
            <button
              key={member.userId}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => onPick({ kind: 'user', userId: member.userId })}
              className="flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full border-0 bg-bubble py-0 pl-1 pr-3 text-[13px] text-ink"
            >
              <PersonAvatar label={member.displayName} size={26} tone={toneOf(member.userId, me)} />
              {member.displayName}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** 输入框上面那行：几个 AI 在忙，谁在旁听 */
function BusyLine() {
  const { group, models } = useRoom();
  const busy = group.ais.filter((ai) => ai.runId);
  const idle = group.ais.filter((ai) => !ai.runId);
  if (!busy.length) return null;
  const names = idle.map((ai) => aiLook(models, ai.key).name);
  return (
    <p className="m-0 mx-auto mb-2.5 flex h-[30px] items-center gap-2 text-[12.5px] text-ink-muted">
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
      {busy.length} 个 AI 在忙{names.length ? `，${names.join('、')} 在旁听` : ''}
    </p>
  );
}

export function RoomComposer({
  mentions,
  onMentions,
}: {
  mentions: Mention[];
  onMentions: (next: Mention[]) => void;
}) {
  const room = useRoom();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // @ 上谁以后（从弹层里挑的、舞台卡片上点的）光标回到输入框
  useEffect(() => {
    if (mentions.length) inputRef.current?.focus();
  }, [mentions]);
  const { group, online, sending } = room;
  const [draft, setDraft] = useState('');
  const [picking, setPicking] = useState(false);
  const locked = !online || sending;
  const canSend = !locked && draft.trim().length > 0;

  async function send() {
    if (!canSend) return;
    if (await room.send(draft.trim(), mentions)) {
      setDraft('');
      onMentions([]);
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
    setPicking(false);
  }
  const placeholder = sending
    ? '发送中…'
    : mentions.length
      ? '说说要它做什么'
      : group.ais.length
        ? '说点什么，或者 @ 一个 AI'
        : '说点什么';

  return (
    <footer className="relative flex flex-col px-[18px] pb-[18px] pt-1">
      <BusyLine />
      {picking && <MentionPicker onPick={pick} onClose={() => setPicking(false)} />}
      <div className="glass-composer flex flex-col gap-2 rounded-pop pb-2.5 pl-[18px] pr-3 pt-3">
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
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
          <label htmlFor="group-input" className="sr-only">
            消息
          </label>
          <textarea
            id="group-input"
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
              if (value.endsWith('@') && value.length === draft.length + 1) {
                setPicking(true);
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
            disabled
            aria-label="更多"
            title="作为任务发布、上传文件：即将开放"
            className={`${ROUND} bg-transparent`}
          >
            <Plus size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="召唤某个 AI 或某人"
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
            className={`${ROUND} ${picking ? 'bg-glass-active' : 'bg-transparent'}`}
          >
            <AtSign size={19} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="发送"
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
