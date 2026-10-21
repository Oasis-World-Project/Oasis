import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { dmsQuery, walletQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatUsd } from '../ui/format.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

function greeting(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function MyAisPanel() {
  const { data: dms } = useQuery(dmsQuery);
  const models = useModelMap();
  return (
    <Panel title="我的 AI">
      {!dms?.length && (
        <EmptyHint>
          和 AI 私聊过之后会列在这里。去{' '}
          <Link to="/ais" className="text-ink underline underline-offset-4">
            AI 们
          </Link>{' '}
          认识一个吧。
        </EmptyHint>
      )}
      {dms?.slice(0, 4).map((dm) => {
        const model = dm.modelKey ? models.get(dm.modelKey) : undefined;
        return (
          <Link
            key={dm.id}
            to="/dms/$conversationId"
            params={{ conversationId: dm.id }}
            className="flex min-h-12 items-center gap-3 rounded-card px-2.5 text-ink no-underline hover:bg-glass-strong"
          >
            {model && <AiAvatar mono={model.mono} glow={model.glow} size={36} glowing />}
            <span className="flex flex-col">
              <span className="text-sm font-medium">{dm.title}</span>
              <span className="text-xs text-ink-muted">{model?.versionLabel ?? ''}</span>
            </span>
          </Link>
        );
      })}
    </Panel>
  );
}

function UsagePanel() {
  const wallet = useQuery(walletQuery);
  return (
    <Panel title="本月用量">
      {wallet.data ? (
        <div className="flex items-end gap-6 px-1">
          <div className="flex flex-col">
            <span className="text-xs text-ink-muted">可用额度</span>
            <span className="font-display text-[28px] font-medium">
              {formatUsd(wallet.data.availableMicro)}
            </span>
          </div>
          <div className="flex flex-col pb-1">
            <span className="text-xs text-ink-muted">本月已用</span>
            <span className="font-display text-base">
              {formatUsd(wallet.data.spentThisMonthMicro)}
            </span>
          </div>
        </div>
      ) : (
        <EmptyHint>新用户赠送 $30 额度，正在到账…</EmptyHint>
      )}
    </Panel>
  );
}

export function HomePage() {
  const now = new Date();
  const today = `${now.getMonth() + 1} 月 ${now.getDate()} 日，${WEEKDAYS[now.getDay()]}。`;
  return (
    <>
      <PageHeader
        title={greeting(now.getHours())}
        description={`${today}有等你确认的事、在干活的 AI，都会汇总在这里。`}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-[18px]">
        <Panel title="正在进行" className="col-span-2 max-[960px]:col-span-1">
          <EmptyHint>你参与的群会出现在这里，显示最后一句话和 AI 们在不在干活。</EmptyHint>
        </Panel>
        <Panel title="任务">
          <EmptyHint>发布的任务会显示成进度环，等你确认的可以一键去处理。</EmptyHint>
        </Panel>
        <MyAisPanel />
        <UsagePanel />
      </div>
    </>
  );
}
