import { Link } from '@tanstack/react-router';

export function NotFoundPage() {
  return (
    <div className="oasis-ground flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="m-0 text-[38px] font-light">没有这个页面</h1>
      <Link to="/" className="text-sm text-ink underline underline-offset-4">
        回到首页
      </Link>
    </div>
  );
}
