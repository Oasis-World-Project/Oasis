// 「召唤谁来回答」：全体 AI、每个 AI（在忙 / 有空）、也可以叫人。照原型 ③。
import type { Mention } from '@oasis/contracts/conversation';
import { AiAvatar } from '../ui/Avatar.tsx';
import { MemberAvatar } from './Members.tsx';
import { aiLook } from './people.ts';
import { Popover } from './RoomHeader.tsx';
import { useRoom } from './room.ts';

export function MentionPicker({
  anchor,
  onPick,
  onClose,
}: {
  /** 弹层的下沿放在哪（输入框上面有没有「谁在忙」那一行，位置不一样） */
  anchor: string;
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
      className={`${anchor} left-[18px] w-[500px] max-w-[calc(100%-36px)] gap-3.5 rounded-[30px] p-4`}
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
              <MemberAvatar member={member} size={26} />
              {member.displayName}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
