import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { logout, meQuery, walletQuery } from '../api/queries.ts';
import { formatUsd } from '../ui/format.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

function Stat({ label, value, text = false }: { label: string; value: string; text?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-card bg-glass-strong px-4 py-3 shadow-edge-strong">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`m-0 font-medium ${text ? 'break-all text-[15px]' : 'font-display text-xl'}`}>
        {value}
      </dd>
    </div>
  );
}

export function MePage() {
  const { data: me } = useQuery(meQuery);
  const wallet = useQuery(walletQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);

  async function signOut() {
    setLeaving(true);
    try {
      await logout();
    } finally {
      queryClient.clear();
      await navigate({ to: '/login', search: {} });
    }
  }

  return (
    <>
      <PageHeader title="我" description="账户与额度。调用任何 AI 或工具都从额度里扣。" />
      <Panel title="账户">
        <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          <Stat label="邮箱" value={me?.email ?? '—'} text />
          <Stat
            label="注册时间"
            value={me ? new Date(me.createdAt).toLocaleDateString('zh-CN') : '—'}
          />
        </dl>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={leaving}
          className="h-11 self-start rounded-item border-0 bg-glass-active px-5 text-sm text-ink shadow-edge-strong disabled:opacity-55"
        >
          {leaving ? '正在退出…' : '退出登录'}
        </button>
      </Panel>
      <Panel title="额度">
        {wallet.isPending && <EmptyHint>额度正在到账…</EmptyHint>}
        {wallet.data && (
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <Stat label="可用" value={formatUsd(wallet.data.availableMicro)} />
            <Stat label="本月已用" value={formatUsd(wallet.data.spentThisMonthMicro)} />
            <Stat label="累计获得" value={formatUsd(wallet.data.grantedMicro)} />
            <Stat label="调用中冻结" value={formatUsd(wallet.data.heldMicro)} />
          </dl>
        )}
      </Panel>
    </>
  );
}
