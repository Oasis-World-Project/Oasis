import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
}

/** 玻璃窗口：首页的各个分区、各页面的内容区都用它。 */
export function Panel({ title, children, className = '' }: PanelProps) {
  return (
    <section
      aria-label={title}
      className={`glass flex min-w-0 flex-col gap-3 rounded-panel p-5 ${className}`}
    >
      <h2 className="m-0 px-1 text-base font-medium leading-snug">{title}</h2>
      {children}
    </section>
  );
}

/** 还没有内容时的说明文字。 */
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 rounded-card bg-glass-strong px-4 py-5 text-[13px] text-ink-muted shadow-edge-strong">
      {children}
    </p>
  );
}
