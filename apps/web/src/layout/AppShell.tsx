import { Outlet } from '@tanstack/react-router';
import { Sidebar } from './Sidebar.tsx';

/** 应用主体：柔光底 + 左侧玻璃侧栏 + 右侧页面。 */
export function AppShell() {
  return (
    <div className="oasis-ground flex min-h-screen gap-[18px] p-[18px]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col gap-[18px] px-1 pt-2">
        <Outlet />
      </main>
    </div>
  );
}
