// 群页顶上：群名、几个人几个 AI、真人头像叠放（点开是成员）、「⋯」群设置。照原型 ②。
import type { GroupSpeak } from '@oasis/contracts/group';
import { Ellipsis } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  createGroupInvite,
  deleteGroup,
  removeGroupMember,
  revokeGroupInvite,
  setGroupOptions,
} from '../api/queries.ts';
import { ConfirmButton } from '../chat/parts.tsx';
import { PersonAvatar } from '../ui/Avatar.tsx';
import { headcount, toneOf } from './people.ts';
import { useRoom } from './room.ts';

/** 没人被 @ 的时候 AI 们怎么办；后两种还没做 */
const SPEAK: { id: GroupSpeak; label: string; desc: string; ready: boolean }[] = [
  { id: 'mention', label: '只在被 @ 时', desc: '点到谁谁才说话', ready: true },
  { id: 'auto', label: '看情况', desc: '和自己的角色相关才开口（即将开放）', ready: false },
  { id: 'active', label: '积极参与', desc: '每条消息都可能有 AI 接话（即将开放）', ready: false },
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
            disabled={!owner || !option.ready || busy}
            onClick={() =>
              void act(() => setGroupOptions(group.id, { speak: option.id })).then(onClose)
            }
            className={`flex items-center gap-2.5 rounded-[20px] border-0 px-3 py-2.5 text-left text-ink disabled:cursor-default ${
              on ? 'bg-glass-active' : 'bg-transparent'
            } ${option.ready ? '' : 'opacity-60'}`}
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
            question="删除群及全部消息？此操作无法恢复。"
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
  const [invite, setInvite] = useState('');
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
            <PersonAvatar label={member.displayName} size={30} tone={toneOf(member.userId, me)} />
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
      {owner && (
        <div className="flex flex-col gap-2 border-0 border-t border-solid border-hairline pt-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className="h-9 rounded-full border-0 bg-solid px-4 text-[13px] font-medium text-on-solid disabled:opacity-45"
              onClick={() =>
                void act(async () => {
                  setInvite((await createGroupInvite(group.id)).token);
                })
              }
            >
              生成单次邀请
            </button>
            <button
              type="button"
              disabled={busy}
              className="h-9 rounded-full border-0 bg-well px-4 text-[13px] text-ink disabled:opacity-45"
              onClick={() =>
                void act(async () => {
                  await revokeGroupInvite(group.id);
                  setInvite('');
                })
              }
            >
              撤销邀请
            </button>
          </div>
          {invite && (
            <>
              <label className="flex flex-col gap-1 text-xs text-ink-muted">
                邀请码
                <input
                  readOnly
                  value={invite}
                  className="h-9 min-w-0 rounded-full border-0 bg-glass-active px-3.5 text-ink shadow-edge-strong"
                />
              </label>
              <button
                type="button"
                className="h-9 self-start rounded-full border-0 bg-well px-4 text-[13px] text-ink"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${window.location.origin}/groups#invite=${invite}`,
                  )
                }
              >
                复制邀请链接
              </button>
            </>
          )}
          <p className="m-0 text-xs text-ink-muted">
            邀请 24 小时有效，只能用一次；重新生成会使旧邀请失效。
          </p>
        </div>
      )}
    </Popover>
  );
}

export function RoomHeader({ onLeft, children }: { onLeft: () => void; children: ReactNode }) {
  const { group, me, online } = useRoom();
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
              <PersonAvatar label={member.displayName} size={34} tone={toneOf(member.userId, me)} />
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
