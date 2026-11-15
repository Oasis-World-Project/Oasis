import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { dmsQuery, meQuery } from '../api/queries.ts';
import { aiName, useModelMap } from '../api/use-model-map.ts';
import { AddFriendDialog } from '../friends/AddFriendDialog.tsx';
import { FriendsPanel } from '../friends/FriendsPanel.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function DmsPage() {
  const { data: dms, isPending } = useQuery(dmsQuery);
  const { data: me } = useQuery(meQuery);
  const models = useModelMap();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-60 flex-1">
          <PageHeader title="私聊" description="和好友、和单个 AI 一对一聊天。" />
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="h-11 cursor-pointer rounded-full border-0 bg-solid px-5 text-sm font-medium text-on-solid"
        >
          加好友
        </button>
      </div>
      {adding && me && <AddFriendDialog me={me.id} onClose={() => setAdding(false)} />}
      <FriendsPanel />
      <Panel title="和 AI 的私聊">
        {isPending && <EmptyHint>正在加载…</EmptyHint>}
        {dms?.length === 0 && (
          <EmptyHint>
            还没有和 AI 的私聊。去{' '}
            <Link to="/ais" className="text-ink underline underline-offset-4">
              AI 们
            </Link>{' '}
            选一个 AI 开始聊天。
          </EmptyHint>
        )}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {dms?.map((dm) => {
            const model = dm.modelKey ? models.get(dm.modelKey) : undefined;
            return (
              <li key={dm.id}>
                <Link
                  to="/dms/$conversationId"
                  params={{ conversationId: dm.id }}
                  className="flex min-h-14 items-center gap-3 rounded-card px-3 text-ink no-underline hover:bg-glass-strong"
                >
                  {model && <AiAvatar mono={model.mono} glow={model.glow} size={36} />}
                  <span className="flex flex-col">
                    <span className="text-[15px] font-medium">{aiName(models, dm)}</span>
                    <span className="text-xs text-ink-muted">{model?.versionLabel ?? ''}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
