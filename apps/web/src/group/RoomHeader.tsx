// 聊天页顶上。群：群名、几个人几个 AI、金库、真人头像叠放（点开是成员）、「⋯」群设置。照原型 ②。
// 和一个好友的私聊：页头是对方的头像和名字。和一个 AI 的私聊：它的头像和名字、在哪干活，「开新话题」、删除。
import type { GroupSpeak } from '@oasis/contracts/group';
import { Ellipsis } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  deleteDm,
  deleteGroup,
  newTopic,
  removeGroupMember,
  setGroupOptions,
} from '../api/queries.ts';
import { placeLabel } from '../chat/HomeBar.tsx';
import { ConfirmButton } from '../chat/parts.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { MemberAvatar, MyNickname, PullFriends } from './Members.tsx';
import { aiLook, headcount } from './people.ts';
import { dmAct, useRoom } from './room.ts';
import { VaultButton } from './Vault.tsx';

/** 没人被 @ 的时候 AI 们怎么办（后两种按概率开口，见《群聊》§3） */
const SPEAK: { id: GroupSpeak; label: string; desc: string }[] = [
  { id: 'mention', label: '只在被 @ 时', desc: '点到谁谁才说话' },
  { id: 'auto', label: '看情况', desc: '有话说的 AI 可能接话，不会自己找话' },
  { id: 'active', label: '积极参与', desc: '更爱接话、互相讨论，偶尔自己起个话头' },
];

/** 弹层：点外面或按 Esc 收起 */
export function Popover({
  label,
  role = 'dialog',
  className,
  onClose,
  children,
}: {
  label: string;
  role?: 'dialog' | 'menu' | 'listbox';
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // 焦点不在弹层里（还在打开它的按钮上）时按 Esc 也要收起
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-10 cursor-default border-0 bg-transparent"
      />
      <div
        role={role}
        aria-label={label}
        className={`glass-pop absolute z-20 box-border flex flex-col ${className}`}
      >
        {children}
      </div>
    </>
  );
}

function RoomMenu({ onClose, onLeft }: { onClose: () => void; onLeft: () => void }) {
  const { group, me, owner, busy, act } = useRoom();
  return (
    <Popover
      label="群设置"
      role="menu"
      onClose={onClose}
      className="right-[22px] top-[76px] w-[300px] gap-0.5 rounded-pop p-2"
    >
      <span className="px-3 pb-1 pt-2 text-[12.5px] text-ink-muted">没人被 @ 的时候，AI 们……</span>
      {SPEAK.map((option) => {
        const on = group.options.speak === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            disabled={!owner || busy}
            onClick={() =>
              void act(() => setGroupOptions(group.id, { speak: option.id })).then(onClose)
            }
            className={`flex items-center gap-2.5 rounded-[20px] border-0 px-3 py-2.5 text-left text-ink disabled:cursor-default ${
              on ? 'bg-glass-active' : 'bg-transparent'
            }`}
          >
            <span className="flex flex-1 flex-col gap-px">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-ink-muted">{option.desc}</span>
            </span>
            <span
              aria-hidden="true"
              className={`size-[18px] rounded-full ${
                on
                  ? 'shadow-[inset_0_0_0_5px_var(--oasis-accent)]'
                  : 'shadow-[inset_0_0_0_1.5px_var(--oasis-accent)]'
              }`}
            />
          </button>
        );
      })}
      <div className="mt-1 border-0 border-t border-solid border-hairline px-1 pt-1.5">
        {owner ? (
          <ConfirmButton
            label="解散群"
            question="删除群及全部消息？金库里剩下的按各人存入的比例退回。此操作无法恢复。"
            confirmLabel="解散群"
            disabled={busy}
            onConfirm={() =>
              void act(() => deleteGroup(group.id)).then((done) => {
                if (done) onLeft();
              })
            }
          />
        ) : (
          <ConfirmButton
            label="退出群"
            question="退出这个群？"
            confirmLabel="退出"
            disabled={busy}
            onConfirm={() =>
              void act(() => removeGroupMember(group.id, me)).then((done) => {
                if (done) onLeft();
              })
            }
          />
        )}
      </div>
    </Popover>
  );
}

function MembersPopover({ onClose }: { onClose: () => void }) {
  const { group, me, owner, busy, act } = useRoom();
  return (
    <Popover
      label={`成员 · ${group.memberCount}`}
      onClose={onClose}
      className="right-[22px] top-[76px] w-[320px] gap-3 rounded-pop p-[18px]"
    >
      <span className="text-[15px] font-medium">成员 · {group.memberCount}</span>
      <ul className="m-0 flex max-h-[40vh] list-none flex-col gap-2 overflow-y-auto p-0">
        {group.members.map((member) => (
          <li key={member.userId} className="flex items-center gap-2.5 text-sm">
            <MemberAvatar member={member} size={30} />
            <span className="min-w-0 flex-1 truncate">
              {member.displayName}
              <span className="text-xs text-ink-muted">
                {member.userId === group.ownerId ? ' · 群主' : ''}
                {member.userId === me ? ' · 你' : ''}
              </span>
            </span>
            {owner && member.userId !== me && (
              <ConfirmButton
                label="移除"
                question="移除这位成员？"
                confirmLabel="移除"
                disabled={busy}
                onConfirm={() => void act(() => removeGroupMember(group.id, member.userId))}
              />
            )}
          </li>
        ))}
      </ul>
      <p className="m-0 text-xs text-ink-muted">{group.historyNotice}</p>
      <MyNickname />
      {owner && <PullFriends />}
    </Popover>
  );
}

/** 和一个好友的私聊：页头是对方 */
function DirectHeader() {
  const { group, me, online } = useRoom();
  const peer = group.members.find((member) => member.userId !== me) ?? group.members[0];
  return (
    <header className="flex items-center gap-3.5 px-7 pb-3 pt-6">
      {peer && <MemberAvatar member={peer} size={46} />}
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-[26px] font-light leading-[1.2] tracking-[0.02em]">
          {peer?.displayName ?? '好友'}
        </h1>
        <p className="mb-0 mt-0.5 text-[13px] text-ink-muted">好友{!online && ' · 连接中…'}</p>
      </div>
    </header>
  );
}

/**
 * 和一个 AI 的私聊：页头是它。「开新话题」：AI 从这里起不记得之前的事（它的记忆和工作目录清掉，聊天记录和
 * 成果都留着）。删除是真删除：消息、成果、AI 的记忆和工作目录都删掉，再点开这个 AI 是全新的空白私聊。
 */
function DmHeader({ onLeft }: { onLeft: () => void }) {
  const room = useRoom();
  const { group, models, online, busy } = room;
  const ai = group.ais[0];
  const look = aiLook(models, ai?.key ?? '', group.title);
  const working = Boolean(ai?.runId);
  const place = group.home
    ? group.home.workplace.kind === 'device'
      ? `在我的电脑上 · ${group.home.workplace.folder}`
      : `在${placeLabel(group.home)}`
    : '';
  return (
    <header className="flex items-center gap-3.5 px-7 pb-3 pt-6">
      <AiAvatar mono={look.mono} glow={look.glow} size={46} glowing={working} />
      <div className="min-w-0 flex-1">
        <h1 className="m-0 truncate text-[26px] font-light leading-[1.2] tracking-[0.02em]">
          {look.name}
        </h1>
        <p className="mb-0 mt-0.5 truncate text-[13px] text-ink-muted" title={place}>
          {working ? '正在做… · ' : ''}
          {place}
          {!online && ' · 连接中…'}
        </p>
      </div>
      <ConfirmButton
        label="开新话题"
        question="AI 会忘掉之前聊的，成果都还在"
        confirmLabel="开新话题"
        disabled={busy || working || group.messages.length === 0}
        onConfirm={() => void dmAct(room, () => newTopic(group.id))}
      />
      <ConfirmButton
        label="删除私聊"
        question="聊天、成果和 AI 的记忆都删掉，不能恢复"
        confirmLabel="删除"
        disabled={busy}
        onConfirm={() =>
          void room
            .act(() => deleteDm(group.id))
            .then((done) => {
              if (done) onLeft();
            })
        }
      />
    </header>
  );
}

export function RoomHeader(props: { onLeft: () => void; children: ReactNode }) {
  const { group } = useRoom();
  if (group.kind === 'direct') return <DirectHeader />;
  return group.kind === 'dm' ? <DmHeader onLeft={props.onLeft} /> : <GroupHeader {...props} />;
}

function GroupHeader({ onLeft, children }: { onLeft: () => void; children: ReactNode }) {
  const { group, online } = useRoom();
  const [open, setOpen] = useState<'menu' | 'members' | null>(null);
  const shown = group.members.slice(0, 5);
  return (
    <header className="relative px-7 pt-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[30px] font-light leading-[1.2] tracking-[0.02em]">
            {group.title}
          </h1>
          <p className="mb-0 mt-1 text-[13px] text-ink-muted">
            {headcount(group)}
            {!online && ' · 连接中…'}
          </p>
        </div>
        <VaultButton />
        <button
          type="button"
          aria-label={`成员 · ${group.memberCount}`}
          aria-expanded={open === 'members'}
          onClick={() => setOpen(open === 'members' ? null : 'members')}
          className="relative mt-1 h-[34px] shrink-0 cursor-pointer border-0 bg-transparent p-0"
          style={{ width: (shown.length - 1) * 22 + 34 }}
        >
          {shown.map((member, index) => (
            <span key={member.userId} className="absolute top-0" style={{ left: index * 22 }}>
              <MemberAvatar member={member} size={34} />
            </span>
          ))}
        </button>
        <button
          type="button"
          aria-label="群设置"
          aria-expanded={open === 'menu'}
          onClick={() => setOpen(open === 'menu' ? null : 'menu')}
          className="flex size-[42px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-glass-strong text-ink shadow-edge-strong"
        >
          <Ellipsis size={18} aria-hidden="true" />
        </button>
      </div>
      {children}
      {open === 'members' && <MembersPopover onClose={() => setOpen(null)} />}
      {open === 'menu' && <RoomMenu onClose={() => setOpen(null)} onLeft={onLeft} />}
    </header>
  );
}
