// 头像：AI 是珍珠白立体形状 + 各自的光色描边（光色来自模型目录数据），在忙时身后发光；真人是柔色圆形 + 首字。
interface AiAvatarProps {
  mono: string;
  glow: string;
  size?: number;
  glowing?: boolean;
}

export function AiAvatar({ mono, glow, size = 36, glowing = false }: AiAvatarProps) {
  const cjk = /\p{Script=Han}/u.test(mono);
  const fontSize = Math.round(size * (cjk ? 0.3 : mono.length > 2 ? 0.26 : 0.34));
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0"
      style={{ width: size, height: size }}
    >
      {glowing && (
        <span
          className="absolute left-[10%] top-[18%] size-[80%] rounded-full opacity-70"
          style={{ background: glow, filter: `blur(${Math.round(size * 0.3)}px)` }}
        />
      )}
      <span
        className={`pearl relative flex size-full items-center justify-center font-medium tracking-[-0.03em] text-ink ${
          cjk ? 'font-sans' : 'font-display'
        }`}
        style={{
          borderRadius: Math.round(size * 0.3),
          fontSize,
          boxShadow: `var(--oasis-pearl-ring), 0 0 0 1.5px ${glow}`,
        }}
      >
        {mono}
      </span>
    </span>
  );
}

export function PersonAvatar({ label, size = 36 }: { label: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-person-me font-medium text-ink shadow-avatar-ring"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
