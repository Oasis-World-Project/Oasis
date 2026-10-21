interface PageHeaderProps {
  title: string;
  description: string;
}

/** 页面顶部：细体大标题 + 一行说明。 */
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="px-1.5 pt-1">
      <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">{title}</h1>
      <p className="mb-0 mt-2 text-sm text-ink-muted">{description}</p>
    </header>
  );
}
