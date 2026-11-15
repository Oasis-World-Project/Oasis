// 群成员的几样东西：一个成员的头像、群主拉好友进群、改自己在这个群里的昵称。
import type { GroupMember } from '@oasis/contracts/group';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addGroupMember, avatarUrl, friendsQuery, setGroupNickname } from '../api/queries.ts';
import { PersonAvatar } from '../ui/Avatar.tsx';
import { toneOf } from './people.ts';
import { useRoom } from './room.ts';

/** 群里一个人的头像：传过头像用头像，没传过是柔色圆加名字的第一个字 */
export function MemberAvatar({
  member,
  size,
}: {
  member: Pick<GroupMember, 'userId' | 'displayName' | 'avatarVersion'>;
  size: number;
}) {
  const { me } = useRoom();
  return (
    <PersonAvatar
      label={member.displayName}
      size={size}
      tone={toneOf(member.userId, me)}
      src={avatarUrl(member.userId, member.avatarVersion)}
    />
  );
}

/** 群主把好友直接拉进群（不用对方同意）：列出还不在群里的好友 */
export function PullFriends() {
  const { group, busy, act } = useRoom();
  const { data } = useQuery(friendsQuery);
  const inside = new Set(group.members.map((member) => member.userId));
  const friends = (data?.friends ?? []).filter((friend) => !inside.has(friend.profile.id));
  return (
    <div className="flex flex-col gap-2 border-0 border-t border-solid border-hairline pt-3">
      <span className="text-[13px] font-medium">拉好友进群</span>
      {friends.length === 0 ? (
        <span className="text-xs text-ink-muted">
          {data?.friends.length ? '好友都在群里了。' : '还没有好友：去「私聊」里按账号 ID 加。'}
        </span>
      ) : (
        <ul className="m-0 flex max-h-[30vh] list-none flex-col gap-2 overflow-y-auto p-0">
          {friends.map(({ profile }) => (
            <li key={profile.id} className="flex items-center gap-2.5 text-sm">
              <PersonAvatar
                label={profile.name}
                size={30}
                src={avatarUrl(profile.id, profile.avatarVersion)}
              />
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              <button
                type="button"
                disabled={busy}
                aria-label={`把 ${profile.name} 拉进群`}
                className="h-8 cursor-pointer rounded-full border-0 bg-solid px-3.5 text-[12.5px] font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
                onClick={() => void act(() => addGroupMember(group.id, profile.id))}
              >
                拉进来
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 我在这个群里的昵称：不设就显示账号的名字 */
export function MyNickname() {
  const { group, me, busy, act } = useRoom();
  const mine = group.members.find((member) => member.userId === me)?.nickname ?? '';
  const [value, setValue] = useState(mine);
  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(() => setGroupNickname(group.id, value.trim()));
  };
  return (
    <form
      onSubmit={save}
      className="flex items-end gap-2 border-0 border-t border-solid border-hairline pt-3"
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-muted">
        我在本群的昵称
        <input
          className="h-9 min-w-0 rounded-full border-0 bg-glass-active px-3.5 text-[13px] text-ink shadow-edge-strong"
          value={value}
          maxLength={40}
          placeholder="不填就显示账号的名字"
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button
        disabled={busy || value.trim() === mine}
        className="h-9 cursor-pointer rounded-full border-0 bg-well px-4 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-45"
      >
        保存
      </button>
    </form>
  );
}
