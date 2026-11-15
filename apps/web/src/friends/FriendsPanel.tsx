// 私聊页里的好友：别人发来的申请（同意、拒绝）、我发出去还没回的（撤回）、好友列表（聊天、删除）。
import type { PublicProfile } from '@oasis/contracts/identity';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  acceptFriend,
  avatarUrl,
  dropFriendRequest,
  friendsQuery,
  openFriendChat,
  removeFriend,
} from '../api/queries.ts';
import { CardButton, ConfirmButton } from '../chat/parts.tsx';
import { PersonAvatar } from '../ui/Avatar.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

/** 一个人的一行：头像、名字、下面一行小字，右边是能做的事 */
function PersonRow({
  profile,
  note,
  children,
}: {
  profile: PublicProfile;
  note: string;
  children: ReactNode;
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 rounded-card px-3 py-2">
      <PersonAvatar
        label={profile.name}
        size={36}
        src={avatarUrl(profile.id, profile.avatarVersion)}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-medium">{profile.name}</span>
        <span className="truncate text-xs text-ink-muted">{note}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </li>
  );
}

export function FriendsPanel() {
  // 别人发来的申请没有推送：隔一会儿看一次
  const { data, isPending } = useQuery({ ...friendsQuery, refetchInterval: 15_000 });
  const client = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** 做一件事，做完重新读好友和申请 */
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await client.invalidateQueries({ queryKey: ['friends'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const chat = (profile: PublicProfile, chatId: string | null) =>
    run(async () => {
      const id = chatId ?? (await openFriendChat(profile.id));
      await navigate({ to: '/chats/$chatId', params: { chatId: id } });
    });
  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];

  return (
    <>
      {incoming.length + outgoing.length > 0 && (
        <Panel title="新朋友">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {incoming.map((request) => (
              <PersonRow
                key={request.id}
                profile={request.profile}
                note={request.message || '想加你为好友'}
              >
                <CardButton
                  tone="solid"
                  disabled={busy}
                  onClick={() => void run(() => acceptFriend(request.id))}
                >
                  同意
                </CardButton>
                <CardButton
                  disabled={busy}
                  onClick={() => void run(() => dropFriendRequest(request.id))}
                >
                  拒绝
                </CardButton>
              </PersonRow>
            ))}
            {outgoing.map((request) => (
              <PersonRow key={request.id} profile={request.profile} note="等对方同意">
                <CardButton
                  disabled={busy}
                  onClick={() => void run(() => dropFriendRequest(request.id))}
                >
                  撤回
                </CardButton>
              </PersonRow>
            ))}
          </ul>
        </Panel>
      )}
      <Panel title="好友">
        {isPending && <EmptyHint>正在加载…</EmptyHint>}
        {data?.friends.length === 0 && (
          <EmptyHint>还没有好友。点右上角「加好友」，输入对方的账号 ID。</EmptyHint>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {error}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {data?.friends.map((friend) => (
            <PersonRow
              key={friend.profile.id}
              profile={friend.profile}
              note={friend.profile.bio || `ID ${friend.profile.accountNo}`}
            >
              <CardButton
                tone="solid"
                disabled={busy}
                onClick={() => void chat(friend.profile, friend.chatId)}
              >
                聊天
              </CardButton>
              <ConfirmButton
                label="删除"
                question="删除这位好友？你们的聊天记录会一起删掉。"
                confirmLabel="删除"
                disabled={busy}
                onConfirm={() => void run(() => removeFriend(friend.profile.id))}
              />
            </PersonRow>
          ))}
        </ul>
      </Panel>
    </>
  );
}
