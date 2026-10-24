import { Outlet } from '@tanstack/react-router';
import { DesktopSync } from '../desktop/DesktopSync.tsx';
import { Sidebar } from './Sidebar.tsx';

/** 应用主体：柔光底 + 左侧玻璃侧栏 + 右侧页面。 */
export function AppShell() {
  return (
    <div className="oasis-ground flex min-h-screen gap-[18px] p-[18px]">
      <Sidebar />
      {/* 桌面端：后台把新成果同步到电脑（浏览器里什么也不做） */}
      <DesktopSync />
      <main className="flex min-w-0 flex-1 flex-col gap-[18px] px-1 pt-2">
        <Outlet />
      </main>
    </div>
  );
}
