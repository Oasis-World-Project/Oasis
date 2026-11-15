import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { groupsQuery } from '../api/queries.ts';
import { NewGroupDialog } from '../group/NewGroupDialog.tsx';

const button = 'rounded-full border-0 bg-accent px-4 py-2 text-on-accent disabled:opacity-45';

export function GroupsPage() {
  const query = useQuery(groupsQuery),
    navigate = useNavigate();
  const { hash } = useLocation();
  const router = useRouter();
  const [creating, setCreating] = useState(hash === 'create-group');
  useEffect(
    () =>
      router.subscribe('onBeforeNavigate', ({ toLocation }) => {
        // 侧栏的「拉群」带着这个记号过来：打开拉群弹窗
        if (toLocation.hash === 'create-group') setCreating(true);
      }),
    [router],
  );
  return (
    <>
      <PageHeader title="群聊" description="和朋友、和各家 AI 在同一个群里聊想法、做计划。" />
      {creating && (
        <NewGroupDialog
          onClose={() => {
            setCreating(false);
            void navigate({ to: '/groups', hash: '', replace: true });
          }}
        />
      )}
      <Panel title="我的群">
        {query.isPending && <EmptyHint>正在加载…</EmptyHint>}
        {query.isError && <p role="alert">{query.error.message}</p>}
        {query.data?.length === 0 && (
          <EmptyHint>还没有群。可以拉一个，或者让朋友加你为好友后把你拉进他的群。</EmptyHint>
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
      <button type="button" className={`${button} self-start`} onClick={() => setCreating(true)}>
        拉个新群
      </button>
    </>
  );
}
