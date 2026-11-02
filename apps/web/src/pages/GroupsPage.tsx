import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createGroup, groupsQuery, previewGroupInvite, redeemGroupInvite } from '../api/queries.ts';
import { GROUP_HISTORY_NOTICE } from '@oasis/contracts/group';

const input = 'rounded-item border-0 bg-glass-active px-3 py-2 text-ink shadow-edge-strong';
const button = 'rounded-full border-0 bg-accent px-4 py-2 text-on-accent disabled:opacity-45';

export function GroupsPage() {
  const query = useQuery(groupsQuery),
    client = useQueryClient(),
    navigate = useNavigate();
  const { hash } = useLocation();
  const router = useRouter();
  const [title, setTitle] = useState(''),
    [name, setName] = useState(''),
    [token, setToken] = useState(() => new URLSearchParams(hash).get('invite') ?? '');
  const [invite, setInvite] = useState<{ title: string } | null>(null),
    [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      const value = new URLSearchParams(toLocation.hash).get('invite');
      if (value) {
        setToken(value);
        setInvite(null);
        setConsent(false);
      }
    });
    if (new URLSearchParams(hash).has('invite'))
      void navigate({ to: '/groups', hash: '', replace: true });
    return unsubscribe;
  }, [hash, navigate, router]);
  async function enter(event: FormEvent, join = false) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const group = join
        ? await redeemGroupInvite(token.trim(), name.trim())
        : await createGroup(title.trim(), name.trim());
      await client.invalidateQueries({ queryKey: ['groups'] });
      await navigate({ to: '/groups/$groupId', params: { groupId: group.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    setBusy(true);
    setError('');
    setConsent(false);
    try {
      setInvite(await previewGroupInvite(token.trim()));
    } catch (err) {
      setInvite(null);
      setError(err instanceof Error ? err.message : '邀请不可用');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader title="群聊" description="和朋友在同一个群里聊想法、做计划。" />
      <Panel title="我的群">
        {query.isPending && <EmptyHint>正在加载…</EmptyHint>}
        {query.isError && <p role="alert">{query.error.message}</p>}
        {query.data?.length === 0 && (
          <EmptyHint>还没有群。可以创建一个，或用朋友发来的邀请加入。</EmptyHint>
        )}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {query.data?.map((group) => (
            <li key={group.id}>
              <Link
                to="/groups/$groupId"
                params={{ groupId: group.id }}
                className="flex items-center justify-between rounded-card bg-glass-strong p-4 text-ink no-underline hover:bg-glass-active"
              >
                <span>{group.title}</span>
                <span className="text-xs text-ink-muted">{group.memberCount} 位成员</span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
      {error && (
        <p role="alert" className="text-accent">
          {error}
        </p>
      )}
      <Panel title="创建或加入">
        <label className="flex flex-col gap-2 text-sm">
          你在群里的名字
          <input
            className={input}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            autoComplete="nickname"
          />
        </label>
        <form
          id="create-group"
          onSubmit={(event) => void enter(event)}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-2 text-sm">
            群名称
            <input
              className={input}
              value={title}
              maxLength={40}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="m-0 text-sm text-ink-muted">{GROUP_HISTORY_NOTICE}</p>
          <button className={button} disabled={busy || !title.trim() || !name.trim()}>
            创建群
          </button>
        </form>
        <form onSubmit={(event) => void enter(event, true)} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-2 text-sm">
            邀请码
            <input
              className={input}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setInvite(null);
                setConsent(false);
              }}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className={button}
            disabled={busy || !token.trim()}
            onClick={() => void inspect()}
          >
            查看邀请
          </button>
          {invite && (
            <>
              <p className="m-0">加入「{invite.title}」</p>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                我已了解：{GROUP_HISTORY_NOTICE}
              </label>
              <button className={button} disabled={busy || !consent || !name.trim()}>
                加入群
              </button>
            </>
          )}
        </form>
      </Panel>
    </>
  );
}
