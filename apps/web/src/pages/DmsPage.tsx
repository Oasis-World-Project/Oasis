import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { dmsQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

export function DmsPage() {
  const { data: dms, isPending } = useQuery(dmsQuery);
  const models = useModelMap();
  return (
    <>
      <PageHeader title="私聊" description="和单个 AI 一对一聊天，用的是你给它的设定。" />
      <Panel title="我的私聊">
        {isPending && <EmptyHint>正在加载…</EmptyHint>}
        {dms?.length === 0 && (
          <EmptyHint>
            还没有私聊。去{' '}
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
                    <span className="text-[15px] font-medium">{dm.title}</span>
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
