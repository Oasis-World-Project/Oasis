import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GroupStreamEvent, type GroupSnapshot } from '@oasis/contracts/group';
import { ApiError } from '../api/client.ts';
import {
  createGroupInvite,
  deleteGroup,
  groupSnapshot,
  meQuery,
  removeGroupMember,
  revokeGroupInvite,
  sendGroupMessage,
} from '../api/queries.ts';
import { Composer } from '../chat/Composer.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { useStickToBottom } from '../chat/use-stick-to-bottom.ts';
import { ConfirmButton } from '../chat/parts.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { Panel } from '../ui/Panel.tsx';

function merge(previous: GroupSnapshot | null, next: GroupSnapshot): GroupSnapshot {
  const messages = new Map(previous?.messages.map((message) => [message.id, message]));
  for (const message of next.messages) messages.set(message.id, message);
  return { ...next, messages: [...messages.values()].sort((a, b) => a.seq - b.seq) };
}
function GroupRoom({ id }: { id: string }) {
  const [group, setGroup] = useState<GroupSnapshot | null>(null),
    [error, setError] = useState(''),
    [online, setOnline] = useState(false),
    [sending, setSending] = useState(false),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState('');
  const [older, setOlder] = useState(true);
  const revoked = useRef(false),
    input = useRef<HTMLTextAreaElement>(null),
    pending = useRef<{ content: string; id: string } | null>(null);
  const files = useAttachments(),
    me = useQuery(meQuery),
    client = useQueryClient(),
    navigate = useNavigate();
  const owner = group?.ownerId === me.data?.id;
  useEffect(() => {
    const source = new EventSource(`/api/conversation/v1/groups/${id}/events`);
    let closed = false;
    const remove = () => {
      revoked.current = true;
      setGroup(null);
      setOnline(false);
      setError('这个群已解散，或你已不在群里。');
      source.close();
      void client.invalidateQueries({ queryKey: ['groups'] });
    };
    source.onmessage = (event) => {
      if (closed || revoked.current) return;
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        setError('群消息格式不正确，请刷新重试');
        return;
      }
      const value = GroupStreamEvent.safeParse(payload);
      if (!value.success) {
        setError('群消息格式不正确，请刷新重试');
        return;
      }
      if (value.data.type === 'removed') {
        remove();
        return;
      }
      const snapshot = value.data.snapshot;
      setGroup((previous) => merge(previous, snapshot));
      setOnline(true);
      setError('');
    };
    source.onerror = () => {
      if (closed || revoked.current) return;
      setOnline(false);
      void groupSnapshot(id).catch((err) => {
        if (!closed && err instanceof ApiError && [401, 403, 404].includes(err.status)) remove();
      });
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [id, client]);
  async function action(work: () => Promise<unknown>, leave = false) {
    setBusy(true);
    setError('');
    try {
      await work();
      await client.invalidateQueries({ queryKey: ['groups'] });
      if (leave) {
        revoked.current = true;
        setGroup(null);
        await navigate({ to: '/groups' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function send(content: string) {
    if (sending || revoked.current) return false;
    setSending(true);
    setError('');
    if (pending.current?.content !== content)
      pending.current = { content, id: crypto.randomUUID() };
    try {
      const snapshot = await sendGroupMessage(id, content, pending.current.id);
      if (!revoked.current) setGroup((previous) => merge(previous, snapshot));
      pending.current = null;
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，重试不会重复发送');
      return false;
    } finally {
      setSending(false);
    }
  }
  async function loadOlder() {
    if (!group?.messages.length || revoked.current) return;
    setBusy(true);
    try {
      const snapshot = await groupSnapshot(id, group.messages[0]!.seq);
      if (!revoked.current) {
        setGroup((previous) => merge(previous, snapshot));
        if (snapshot.messages.length < 100) setOlder(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '历史消息加载失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title={group?.title ?? '群聊'}
        description={error && !group ? '暂时无法访问' : online ? '已连接' : '连接中…'}
      />
      <Link to="/groups" className="text-sm text-ink-muted">
        返回群列表
      </Link>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      {group && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]" data-light="mint">
          <Panel title="群消息">
            <p className="m-0 text-xs text-ink-muted">{group.historyNotice}</p>
            {older && group.messages[0] && group.messages[0].seq > 1 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadOlder()}
                className="rounded-full border-0 bg-track px-4 py-2 text-ink"
              >
                查看更早消息
              </button>
            )}
            <GroupMessages messages={group.messages} userId={me.data?.id} />
            {!group.messages.length && (
              <p className="text-sm text-ink-muted">发一句话，开始聊天。</p>
            )}
            <Composer
              textOnly
              locked={!online || sending}
              sending={sending}
              hint={null}
              inputRef={input}
              attachments={files}
              onSend={send}
            />
          </Panel>
          <Panel title={`成员 · ${group.memberCount}`}>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {group.members.map((member) => (
                <li key={member.userId} className="flex flex-col gap-1 text-sm">
                  <span>
                    {member.displayName}
                    {member.userId === group.ownerId ? ' · 群主' : ''}
                    {member.userId === me.data?.id ? ' · 你' : ''}
                  </span>
                  {owner && member.userId !== me.data?.id && (
                    <ConfirmButton
                      label="移除"
                      question="移除这位成员？"
                      confirmLabel="移除"
                      disabled={busy}
                      onConfirm={() => void action(() => removeGroupMember(id, member.userId))}
                    />
                  )}
                </li>
              ))}
            </ul>
            {owner ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-full border-0 bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-45"
                  onClick={() =>
                    void action(async () => {
                      const result = await createGroupInvite(id);
                      setInvite(result.token);
                    })
                  }
                >
                  生成单次邀请
                </button>
                <p className="m-0 text-xs text-ink-muted">24 小时有效。重新生成会使旧邀请失效。</p>
                {invite && (
                  <>
                    <label className="flex flex-col gap-1 text-xs">
                      邀请码
                      <input
                        readOnly
                        value={invite}
                        className="min-w-0 rounded-item border-0 bg-track p-2 text-ink"
                      />
                    </label>
                    <button
                      type="button"
                      className="rounded-full border-0 bg-track px-3 py-2 text-sm text-ink"
                      onClick={() =>
                        void action(() =>
                          navigator.clipboard.writeText(
                            `${window.location.origin}/groups#invite=${invite}`,
                          ),
                        )
                      }
                    >
                      复制邀请链接
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-full border-0 bg-track px-3 py-2 text-sm text-ink"
                  onClick={() =>
                    void action(async () => {
                      await revokeGroupInvite(id);
                      setInvite('');
                    })
                  }
                >
                  撤销邀请
                </button>
                <ConfirmButton
                  label="解散群"
                  question="删除群及全部消息？此操作无法恢复。"
                  confirmLabel="解散群"
                  disabled={busy}
                  onConfirm={() => void action(() => deleteGroup(id), true)}
                />
              </>
            ) : (
              <ConfirmButton
                label="退出群"
                question="退出这个群？"
                confirmLabel="退出"
                disabled={busy}
                onConfirm={() => void action(() => removeGroupMember(id, me.data!.id), true)}
              />
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
function GroupMessages({
  messages,
  userId,
}: {
  messages: GroupSnapshot['messages'];
  userId?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null),
    content = useRef<HTMLOListElement>(null);
  useStickToBottom(scroller, content);
  return (
    <div ref={scroller} className="max-h-[60vh] overflow-y-auto">
      <ol ref={content} className="m-0 flex list-none flex-col gap-4 p-0" aria-label="群消息记录">
        {messages.map((message) => (
          <li
            key={message.id}
            className={message.authorId === userId ? 'ml-auto max-w-[90%]' : 'mr-auto max-w-[90%]'}
          >
            <p className="mb-1 mt-0 text-xs text-ink-muted">
              {message.displayName}
              {message.authorId === userId ? ' · 你' : ''}
              <time className="ml-2" dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </p>
            <p className="m-0 whitespace-pre-wrap break-words rounded-card bg-glass-strong px-4 py-3 text-sm text-ink">
              {message.content}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
export function GroupPage() {
  const { groupId } = useParams({ strict: false }) as { groupId: string };
  return <GroupRoom key={groupId} id={groupId} />;
}
