// 参数面板（ADR 0012 §12）：成品参数的表单，每项默认「不变」。
// 能预览的改了就在画面上看到（近似效果）；填好后「按这些参数改一版」交给发给 AI 修改的对话框。
import type { RevisionParameter } from '@oasis/contracts/conversation';
import { RotateCcw, Sparkles, X } from 'lucide-react';
import { formatValue, toParameters, type Field, type Values } from './parameters.ts';

const input =
  'rounded-item border-0 bg-glass-active px-3 py-1.5 text-[13px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';
const chip = (on: boolean) =>
  `h-7 rounded-full border-0 px-3 text-[12.5px] ${on ? 'bg-solid text-on-solid' : 'bg-track text-ink'}`;

function Control({
  field,
  value,
  set,
}: {
  field: Field;
  value: Values[string] | undefined;
  set: (value: Values[string] | undefined) => void;
}) {
  switch (field.kind) {
    case 'choice':
      return (
        <div role="radiogroup" aria-label={field.label} className="flex flex-wrap gap-1.5">
          {field.options.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={value === option}
              onClick={() => set(value === option ? undefined : option)}
              className={chip(value === option)}
            >
              {option}
            </button>
          ))}
        </div>
      );
    case 'range': {
      const n = typeof value === 'number' ? value : field.unit === '倍' ? 1 : 0;
      return (
        <div className="flex items-center gap-2">
          <input
            type="range"
            aria-label={field.label}
            min={field.min}
            max={field.max}
            step={field.step}
            value={n}
            onChange={(e) => set(Number(e.target.value))}
            className="min-w-0 flex-1 accent-accent"
          />
          <span className="w-16 shrink-0 text-right font-display text-[12px] text-ink-muted">
            {value === undefined ? '不变' : formatValue(field, n)}
          </span>
        </div>
      );
    }
    case 'text':
      return (
        <div className="flex flex-col gap-1.5">
          {field.suggestions && (
            <div className="flex flex-wrap gap-1.5">
              {field.suggestions.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={value === option}
                  onClick={() => set(value === option ? undefined : option)}
                  className={chip(value === option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <input
            aria-label={field.label}
            value={typeof value === 'string' ? value : ''}
            maxLength={100}
            placeholder={field.placeholder}
            onChange={(e) => set(e.target.value || undefined)}
            className={input}
          />
        </div>
      );
    case 'color':
      return (
        <div className="flex items-center gap-2">
          {/* 取色器写进文字框；也可以直接写颜色名 */}
          <input
            type="color"
            aria-label={`${field.label}取色器`}
            onChange={(e) => set(e.target.value)}
            className="size-8 shrink-0 cursor-pointer rounded-item border-0 bg-transparent p-0"
          />
          <input
            aria-label={field.label}
            value={typeof value === 'string' ? value : ''}
            maxLength={60}
            placeholder="取色，或者写颜色名，如 胡桃木色"
            onChange={(e) => set(e.target.value || undefined)}
            className={`${input} min-w-0 flex-1`}
          />
        </div>
      );
    case 'size': {
      const [w, h] = (value as [number, number] | undefined) ?? [0, 0];
      const update = (next: [number, number]) => set(next[0] || next[1] ? next : undefined);
      return (
        <div className="flex items-center gap-2 text-[13px]">
          <input
            type="number"
            aria-label="宽（像素）"
            min={16}
            max={8192}
            value={w || ''}
            placeholder="宽"
            onChange={(e) => update([Number(e.target.value), h])}
            className={`${input} w-24`}
          />
          ×
          <input
            type="number"
            aria-label="高（像素）"
            min={16}
            max={8192}
            value={h || ''}
            placeholder="高"
            onChange={(e) => update([w, Number(e.target.value)])}
            className={`${input} w-24`}
          />
          像素
        </div>
      );
    }
  }
}

export function ParameterPanel({
  file,
  fields,
  values,
  onChange,
  onRevise,
  onClose,
  previewable,
}: {
  file: string;
  fields: Field[];
  values: Values;
  onChange: (values: Values) => void;
  onRevise: (parameters: RevisionParameter[]) => void;
  onClose: () => void;
  /** 这一类里能近似预览的项 */
  previewable: string[];
}) {
  const parameters = toParameters(file, fields, values);
  const set = (key: string, value: Values[string] | undefined) => {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  return (
    <aside
      aria-label="参数"
      className="flex max-h-[42%] w-full shrink-0 flex-col gap-3 overflow-auto rounded-card bg-glass-active p-4 shadow-edge-strong lg:max-h-none lg:w-[300px]"
    >
      <header className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-[15px] font-medium">参数</h2>
        {parameters.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({})}
            className="inline-flex h-8 items-center gap-1 rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted"
          >
            <RotateCcw size={13} aria-hidden="true" />
            全部不变
          </button>
        )}
        <button
          type="button"
          aria-label="收起参数"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-full border-0 bg-track text-ink"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
        要改的项选一个新值，没动的保持不变。填好后交给 AI 做出新版。
        {previewable.length > 0 &&
          `${previewable.join('、')}改了能在画面上直接看到，但只是近似效果，新版做出来才是真的。`}
      </p>
      <div className="flex flex-col gap-3.5">
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium">
              {field.label}
              {values[field.key] !== undefined && (
                <button
                  type="button"
                  onClick={() => set(field.key, undefined)}
                  className="ml-2 border-0 bg-transparent p-0 text-[11.5px] font-normal text-ink-muted underline"
                >
                  不变
                </button>
              )}
            </span>
            <Control field={field} value={values[field.key]} set={(v) => set(field.key, v)} />
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={parameters.length === 0}
        onClick={() => onRevise(parameters)}
        className="mt-1 inline-flex h-10 items-center justify-center gap-1.5 rounded-full border-0 bg-accent px-4 text-[13.5px] font-medium text-on-accent disabled:opacity-45"
      >
        <Sparkles size={14} aria-hidden="true" />
        按这些参数改一版{parameters.length ? `（${parameters.length} 项）` : ''}
      </button>
    </aside>
  );
}
