// 卡片（问卷、任务单）和几处按钮共用的小东西：标题行、状态标签、按钮、点了再问一句的按钮。
import { useState, type ReactNode } from 'react';

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
      <span className="whitespace-nowrap text-[13px] text-ink-muted">{question}</span>
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

/** 卡片里的单选项（问卷的选项） */
export function Choice({
  name,
  label,
  checked,
  onChange,
  disabled,
  isDefault,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  isDefault?: boolean;
}) {
  return (
    <label
      // relative：看不见的单选框铺满这一格，位置跟着这一格走
      className={`relative inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13.5px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
        checked ? 'bg-solid text-on-solid' : 'bg-glass-active text-ink shadow-edge-strong'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="absolute inset-0 m-0 size-full cursor-[inherit] opacity-0"
      />
      {label}
      {isDefault && <span className={checked ? 'opacity-70' : 'text-ink-muted'}>· 默认</span>}
    </label>
  );
}
