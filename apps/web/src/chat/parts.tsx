// 卡片共用的外框和按钮。卡片都是 AI 发的，左边带 AI 头像；材质统一是磨砂玻璃。
import { useState, type ReactNode } from 'react';
import { AiAvatar } from '../ui/Avatar.tsx';

export interface Speaker {
  mono: string;
  glow: string;
}

export function CardFrame({
  speaker,
  label,
  glowing = false,
  dim = false,
  children,
}: {
  speaker: Speaker;
  /** 卡片的无障碍名称，如「问题卡」 */
  label: string;
  glowing?: boolean;
  /** 已经过去的卡片（被替换、取消）淡一些 */
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <AiAvatar mono={speaker.mono} glow={speaker.glow} size={30} glowing={glowing} />
      <section
        aria-label={label}
        className={`flex w-full max-w-[560px] flex-col gap-3.5 rounded-card bg-glass-strong px-5 py-4 shadow-edge-strong ${
          dim ? 'opacity-60' : ''
        }`}
      >
        {children}
      </section>
    </div>
  );
}

/** 卡片顶上的小标题行：左边类别，右边状态 */
export function CardHeading({
  kind,
  title,
  status,
}: {
  kind: string;
  title?: string;
  status?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12px] text-ink-muted">{kind}</span>
        {title && <h3 className="m-0 text-[16px] font-medium leading-snug">{title}</h3>}
      </div>
      {status}
    </header>
  );
}

export function StatusTag({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'accent' | 'solid';
}) {
  const toneClass = {
    muted: 'bg-glass-active text-ink-muted',
    accent: 'bg-accent text-on-accent',
    solid: 'bg-solid text-on-solid',
  }[tone];
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium leading-none ${toneClass}`}
    >
      {children}
    </span>
  );
}

type ButtonTone = 'accent' | 'solid' | 'plain' | 'text';

const BUTTON: Record<ButtonTone, string> = {
  accent: 'h-10 px-4 bg-accent text-on-accent font-medium',
  solid: 'h-10 px-4 bg-solid text-on-solid font-medium',
  plain: 'h-10 px-4 bg-glass-active text-ink shadow-edge-strong',
  text: 'h-10 px-2 bg-transparent text-ink-muted hover:text-ink',
};

export function CardButton({
  tone = 'plain',
  onClick,
  disabled,
  children,
}: {
  tone?: ButtonTone;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border-0 text-[13.5px] disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON[tone]}`}
    >
      {children}
    </button>
  );
}

/** 不可撤销的操作（取消任务等）点两下：先问一句再做 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  tone = 'text',
}: {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <CardButton tone={tone} onClick={() => setAsking(true)} disabled={disabled}>
        {label}
      </CardButton>
    );
  }
  return (
    <span role="group" aria-label={question} className="inline-flex items-center gap-1.5">
      <span className="text-[13px] text-ink-muted">{question}</span>
      <CardButton
        tone="accent"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={disabled}
      >
        {confirmLabel}
      </CardButton>
      <CardButton tone="text" onClick={() => setAsking(false)}>
        算了
      </CardButton>
    </span>
  );
}

export function CardActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-0.5">{children}</div>;
}

/** 一组带小标题的条目（任务单里的「要交付的东西」「怎么算做好」等） */
export function ItemList({ title, items }: { title?: string; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {title && <h4 className="m-0 text-[12.5px] font-medium text-ink-muted">{title}</h4>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-[14px] leading-relaxed">
            <span
              aria-hidden="true"
              className="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink-muted opacity-50"
            />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
