// 输入框里的联网搜索开关：亮着是开，AI 可以用「联网搜索」「读网页」这两个工具；关着时这两个工具不给它。
// 记在这段私聊的设置里（群里是我在这个群的家；和在哪干活、手动自动放一起），下一轮起生效，正在做的一轮不变。
import { useMutation } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import type { Home } from './HomeBar.tsx';

export function WebToggle({ home: { setup, save, onSaved } }: { home: Home }) {
  const on = setup.permissions.web !== false;
  const toggle = useMutation({
    mutationFn: () => save({ ...setup, permissions: { ...setup.permissions, web: !on } }),
    onSuccess: onSaved,
  });
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="联网搜索"
      title={
        on ? '联网搜索：开（点一下关掉，下一轮起生效）' : '联网搜索：关（点一下打开，下一轮起生效）'
      }
      onClick={() => toggle.mutate()}
      disabled={toggle.isPending}
      className={`relative flex size-10 shrink-0 items-center justify-center rounded-full border-0 bg-transparent hover:bg-glass-strong disabled:opacity-45 ${
        on ? 'text-accent' : 'text-ink-muted'
      }`}
    >
      <Globe size={18} aria-hidden="true" />
      {!on && (
        <span
          aria-hidden="true"
          className="absolute h-[1.5px] w-[22px] -rotate-45 rounded-full bg-current"
        />
      )}
    </button>
  );
}
