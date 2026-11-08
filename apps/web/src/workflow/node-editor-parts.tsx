// 编辑节点对话框的各块：通用输入框、模型下拉、讨论节点的参与者、干活节点能用的工具。
import { Plus, X } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { useSpeakers } from './use-speakers.ts';

export type Options = NonNullable<ReturnType<typeof useSpeakers>['options']>;

export interface Participant {
  name: string;
  model: string;
  stance: string;
}

/** 输入框的样子（不含宽度）；一般占满一行，参与者那一行里另给宽度 */
const fieldLook =
  'rounded-item border-0 bg-glass-active px-3.5 py-2.5 text-[14px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';
export const field = `w-full ${fieldLook}`;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function ModelSelect({
  value,
  onChange,
  options,
  label,
  className = field,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Options;
  label?: string;
  className?: string;
}) {
  const known = options.models.some((m) => m.providerModel === value);
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {!known && value && <option value={value}>{value}</option>}
      {options.models.map((m) => (
        <option key={m.providerModel} value={m.providerModel}>
          {m.name} · {m.vendor}
        </option>
      ))}
    </select>
  );
}

/** 讨论节点的参与者（2–5 位）和来回几轮 */
export function ParticipantsField({
  participants,
  setParticipants,
  rounds,
  setRounds,
  options,
  defaultModel,
}: {
  participants: Participant[];
  setParticipants: Dispatch<SetStateAction<Participant[]>>;
  rounds: number;
  setRounds: (rounds: number) => void;
  options: Options;
  defaultModel: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">参与者（2–5 位）</legend>
      {participants.map((p, index) => {
        const set = (patch: Partial<Participant>) =>
          setParticipants((list) => list.map((x, i) => (i === index ? { ...x, ...patch } : x)));
        return (
          <div key={index} className="flex flex-col gap-1.5 rounded-item bg-glass-strong p-2.5">
            <div className="flex gap-1.5">
              <input
                aria-label={`第 ${index + 1} 位的名字`}
                value={p.name}
                onChange={(e) => set({ name: e.target.value })}
                maxLength={30}
                className={`${fieldLook} w-24 shrink-0`}
              />
              <ModelSelect
                label={`第 ${index + 1} 位的模型`}
                value={p.model}
                onChange={(value) => set({ model: value })}
                options={options}
                className={`${fieldLook} min-w-0 flex-1`}
              />
              {participants.length > 2 && (
                <button
                  type="button"
                  onClick={() => setParticipants((list) => list.filter((_, i) => i !== index))}
                  aria-label={`去掉${p.name || `第 ${index + 1} 位`}`}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              )}
            </div>
            <input
              aria-label={`第 ${index + 1} 位的立场`}
              value={p.stance}
              onChange={(e) => set({ stance: e.target.value })}
              className={field}
              placeholder="立场或视角（可选），如：从预算角度挑毛病"
            />
          </div>
        );
      })}
      {participants.length < 5 && (
        <button
          type="button"
          onClick={() =>
            setParticipants((list) => [...list, { name: '', model: defaultModel, stance: '' }])
          }
          className="inline-flex h-9 items-center gap-1 self-start rounded-full border-0 bg-track px-3 text-[13px] text-ink"
        >
          <Plus size={14} aria-hidden="true" />
          加一位
        </button>
      )}
      <Field label="来回几轮">
        <input
          type="number"
          min={1}
          max={5}
          value={rounds}
          onChange={(e) => setRounds(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
          className={`${fieldLook} w-24`}
        />
      </Field>
    </fieldset>
  );
}

/** 干活节点能用的工具：勾上的给个预计用量（按计费单位） */
export function ToolsField({
  tools,
  setTools,
  options,
}: {
  tools: Record<string, number>;
  setTools: Dispatch<SetStateAction<Record<string, number>>>;
  options: Options;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-medium">
        能用的工具
        <span className="ml-1.5 font-normal text-ink-muted">按次收费，记在任务里</span>
      </legend>
      {options.tools.map((tool) => {
        const on = tools[tool.key] !== undefined;
        return (
          <div
            key={tool.key}
            className="flex items-center gap-2 rounded-item bg-glass-strong px-3 py-2"
          >
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={on}
                onChange={() =>
                  setTools((t) => {
                    const next = { ...t };
                    if (on) delete next[tool.key];
                    else next[tool.key] = 1;
                    return next;
                  })
                }
                className="size-4 accent-accent"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13.5px] font-medium">{tool.name}</span>
                <span className="truncate text-[12px] text-ink-muted">{tool.description}</span>
              </span>
            </label>
            {on && (
              <label className="flex shrink-0 items-center gap-1 text-[12px] text-ink-muted">
                预计
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={tools[tool.key]}
                  onChange={(e) =>
                    setTools((t) => ({
                      ...t,
                      [tool.key]: Math.min(50, Math.max(1, Number(e.target.value) || 1)),
                    }))
                  }
                  className="h-8 w-14 rounded-full border-0 bg-glass-active px-2 text-center text-[13px] text-ink shadow-edge-strong"
                />
                {tool.unit}
              </label>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
