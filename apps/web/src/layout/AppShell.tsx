import { Outlet } from '@tanstack/react-router';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { isConnectionError } from '../api/client.ts';
import { DesktopSync } from '../desktop/DesktopSync.tsx';
import { Sidebar } from './Sidebar.tsx';

/** 应用主体：柔光底 + 左侧玻璃侧栏 + 右侧页面。 */
export function AppShell() {
  const client = useQueryClient();
  const online = useSyncExternalStore(onlineManager.subscribe, () => onlineManager.isOnline());
  const unavailable = useSyncExternalStore(
    (listener) => client.getQueryCache().subscribe(listener),
    () =>
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.isActive() && isConnectionError(query.state.error)),
  );
  return (
    <div className="oasis-ground flex min-h-screen gap-[18px] p-[18px]">
      <Sidebar />
      {/* 桌面端：后台把新成果同步到电脑（浏览器里什么也不做） */}
      <DesktopSync />
      <main className="flex min-w-0 flex-1 flex-col gap-[18px] px-1 pt-2">
        {(!online || unavailable) && (
          <div
            role="status"
            className="glass flex items-center justify-between gap-3 rounded-card px-5 py-3 text-sm text-ink-muted"
          >
            <span>
              {!online
                ? '当前离线，已有内容已保留，联网后自动重新连接。'
                : '暂时连不上服务，正在尝试重新连接，已有内容已保留。'}
            </span>
            <button
              type="button"
              disabled={!online}
              onClick={() => void client.refetchQueries({ type: 'active' })}
              className="shrink-0 rounded-full bg-glass-strong px-4 py-2 text-ink"
            >
              重新连接
            </button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
