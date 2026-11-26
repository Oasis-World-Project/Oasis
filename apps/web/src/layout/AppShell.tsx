import { Outlet, useMatches } from '@tanstack/react-router';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { isConnectionError } from '../api/client.ts';
import { DesktopSync } from '../desktop/DesktopSync.tsx';
import { Sidebar } from './Sidebar.tsx';

/** 外壳右侧自己滚动的那一块（换页时路由让它回到顶上） */
export const PAGE_SCROLL_ID = 'page-scroll';

/**
 * 应用主体：柔光底 + 左侧玻璃侧栏 + 右侧页面。外壳固定是窗口那么高、自己不滚，所以里面任何东西都不可能
 * 把整页撑出滚动条。页面有两种：占满这一屏、里面的滚动自己管的（聊天、成果页，路由上标 fixedHeight）；
 * 其余的在右侧这一块里滚。
 */
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
  const fixedHeight = useMatches({
    select: (matches) => matches.some((match) => match.staticData.fixedHeight),
  });
  const notice = (!online || unavailable) && (
    <div
      role="status"
      className="glass flex shrink-0 items-center justify-between gap-3 rounded-card px-5 py-3 text-sm text-ink-muted"
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
  );
  return (
    // isolate：群页把自己的光铺在最底下（负的层级），要压在这层底色上面、别的内容下面。
    // overflow-clip：比 hidden 更严，脚本和焦点引起的滚动也不让，外壳永远停在原位
    <div className="oasis-ground relative isolate flex h-dvh gap-[18px] overflow-clip p-[18px]">
      <Sidebar />
      {/* 桌面端：后台把新成果同步到电脑（浏览器里什么也不做） */}
      <DesktopSync />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {fixedHeight ? (
          <div className="flex min-h-0 flex-1 flex-col gap-[18px] px-1 pt-2">
            {notice}
            <Outlet />
          </div>
        ) : (
          // 四边伸到窗口边（负边距，再用同样大的内边距补回来）：滚动条贴着窗口右边，窗口的投影不会被裁掉
          <div
            id={PAGE_SCROLL_ID}
            className="relative -m-[18px] min-h-0 flex-1 overflow-y-auto px-[22px] pb-[18px] pt-[26px]"
          >
            <div className="flex min-h-full flex-col gap-[18px]">
              {notice}
              <Outlet />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
