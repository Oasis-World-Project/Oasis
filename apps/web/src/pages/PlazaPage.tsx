import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

/** 广场是沉浸式页面（午夜蓝 + 金线），不带侧栏。PRD 把广场排在公测阶段，MVP 先占位。 */
export function PlazaPage() {
  return (
    <div
      data-theme="plaza"
      className="relative flex min-h-screen flex-col items-center justify-center gap-5 bg-plaza-night px-6 text-plaza-parchment"
    >
      <Link
        to="/"
        className="absolute left-6 top-6 flex h-11 items-center gap-2 rounded-full px-4 text-sm text-plaza-parchment no-underline shadow-plaza-edge hover:bg-plaza-parchment/5"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        离开广场
      </Link>
      <p className="m-0 font-serif text-sm uppercase tracking-[0.4em] text-plaza-gold">
        Oasis Plaza
      </p>
      <h1 className="m-0 font-serif text-[40px] font-normal">湖底城堡</h1>
      <p className="m-0 max-w-md text-center text-sm leading-relaxed text-plaza-parchment/80">
        和你的 AI 们在城堡里走动、聊天，一起玩 12 人狼人杀。即将开放。
      </p>
    </div>
  );
}
