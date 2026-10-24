// 加节点 / 改还没开始的节点：名字、要做的事、角色、模型、关卡、工具（干活节点）或参与者和轮数（讨论节点）。
// 新节点先是「新建」状态，不会自动开跑：点节点上的「运行」或工作流的「全部运行」才加入。
import type { NodeBody, PlanNode, TaskBody, UpdateNodeBody } from '@oasis/contracts/task';
import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { useSpeakers } from './use-speakers.ts';

type Options = NonNullable<ReturnType<typeof useSpeakers>['options']>;

interface Participant {
  name: string;
  model: string;
  stance: string;
}

export interface EditorResult {
  /** 新建时给出完整节点；修改时只给改动 */
  node?: PlanNode;
  changes?: UpdateNodeBody;
  /** 新建时接在哪个节点后面 */
  after?: string;
}

/** 节点名（也是下游沙箱里的目录名）：从标题生成，只留字母、数字、下划线和短横线，不和已有的重复 */
export function keyFor(title: string, taken: Set<string>): string {
  const base =
    title
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'node';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  return key;
}

/** 输入框的样子（不含宽度）；一般占满一行，参与者那一行里另给宽度 */
const fieldLook =
  'rounded-item border-0 bg-glass-active px-3.5 py-2.5 text-[14px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';
const field = `w-full ${fieldLook}`;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
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

function ModelSelect({
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

export function NodeEditor({
  task,
  node,
  options,
  busy,
  error,
  onSave,
  onClose,
}: {
  task: TaskBody;
  /** 不给就是新建 */
  node?: NodeBody;
  options: Options;
  busy: boolean;
  error: string | null;
  onSave: (result: EditorResult) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
  }, []);

  const defaultModel = options.models[0]?.providerModel ?? '';
  const [kind, setKind] = useState<'work' | 'discussion'>(node?.kind ?? 'work');
  const [title, setTitle] = useState(node?.title ?? '');
  const [goal, setGoal] = useState(node?.goal ?? '');
  const [role, setRole] = useState(node?.role ?? '');
  const [model, setModel] = useState(node?.model ?? defaultModel);
  const [checks, setChecks] = useState((node?.checks ?? []).join('\n'));
  const [tools, setTools] = useState<Record<string, number>>(
    Object.fromEntries((node?.tools ?? []).map((t) => [t.key, t.uses])),
  );
  const [participants, setParticipants] = useState<Participant[]>(
    node?.discussion?.participants ?? [
      { name: '甲', model: defaultModel, stance: '' },
      { name: '乙', model: defaultModel, stance: '' },
    ],
  );
  const [rounds, setRounds] = useState(node?.discussion?.rounds ?? 2);
  const [after, setAfter] = useState('');

  const checkList = checks
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
  const names = participants.map((p) => p.name.trim());
  const problem = !title.trim()
    ? '先写个名字'
    : !goal.trim()
      ? '再写下要做的事'
      : checkList.length > 5
        ? '关卡最多 5 条'
        : kind === 'discussion' && (names.some((n) => !n) || new Set(names).size !== names.length)
          ? '参与者要有名字，而且不能重名'
          : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem) return;
    const common = {
      title: title.trim(),
      goal: goal.trim(),
      role: role.trim(),
      model,
      checks: checkList,
    };
    const toolList = Object.entries(tools).map(([key, uses]) => ({ key, uses }));
    const cleanParticipants = participants.map((p) => ({ ...p, name: p.name.trim() }));
    if (node) {
      onSave({
        changes: {
          ...common,
          ...(kind === 'work' ? { tools: toolList } : { participants: cleanParticipants, rounds }),
        },
      });
      return;
    }
    const key = keyFor(common.title, new Set(task.nodes.map((n) => n.key)));
    onSave({
      node:
        kind === 'work'
          ? { ...common, key, kind, expects: [], tools: toolList }
          : { ...common, key, kind, expects: [], participants: cleanParticipants, rounds },
      after: after || undefined,
    });
  }

  const sources = task.nodes.filter((n) => n.status !== 'cancelled');

  return (
    <dialog
      ref={dialog}
      aria-label={node ? `编辑节点：${node.title}` : '加一个节点'}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto max-h-[88vh] w-[min(92vw,560px)] max-w-none overflow-hidden rounded-panel border-0 bg-transparent p-0 text-ink backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="flex max-h-[88vh] flex-col rounded-panel bg-glass-active shadow-panel backdrop-blur-2xl"
      >
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <h2 className="m-0 flex-1 text-[17px] font-medium">{node ? '编辑节点' : '加一个节点'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-9 items-center justify-center rounded-full border-0 bg-track text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          {!node && (
            <fieldset className="m-0 flex gap-2 border-0 p-0">
              <legend className="mb-1.5 p-0 text-[13px] font-medium">类型</legend>
              {(
                [
                  ['work', '干活', '一个 AI 完成一件事'],
                  ['discussion', '讨论', '几个 AI 来回几轮，再写结论'],
                ] as const
              ).map(([value, label, desc]) => (
                <label
                  key={value}
                  className={`flex flex-1 cursor-pointer flex-col rounded-item px-3.5 py-2.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                    kind === value ? 'bg-solid text-on-solid' : 'bg-glass-strong shadow-edge-strong'
                  }`}
                >
                  <input
                    type="radio"
                    name="node-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    className="sr-only"
                  />
                  <span className="text-[14px] font-medium">{label}</span>
                  <span className="text-[12px] opacity-75">{desc}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Field label="名字">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              className={field}
              placeholder="如：写首页文案"
            />
          </Field>
          <Field label={kind === 'discussion' ? '讨论的题目' : '要做的事'}>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              className={`${field} resize-y`}
              placeholder={
                kind === 'discussion'
                  ? '如：首页走温馨路线还是简洁路线？'
                  : '说清楚要交出什么，比如：一份首页文案，Markdown'
              }
            />
          </Field>
          {kind === 'work' && (
            <Field label="角色" hint="可选">
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={field}
                placeholder="如：资深文案"
              />
            </Field>
          )}
          <Field label={kind === 'discussion' ? '谁来写结论' : '用哪个模型'}>
            <ModelSelect value={model} onChange={setModel} options={options} />
          </Field>
          {kind === 'discussion' && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1.5 p-0 text-[13px] font-medium">参与者（2–5 位）</legend>
              {participants.map((p, index) => {
                const set = (patch: Partial<Participant>) =>
                  setParticipants((list) =>
                    list.map((x, i) => (i === index ? { ...x, ...patch } : x)),
                  );
                return (
                  <div
                    key={index}
                    className="flex flex-col gap-1.5 rounded-item bg-glass-strong p-2.5"
                  >
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
                          onClick={() =>
                            setParticipants((list) => list.filter((_, i) => i !== index))
                          }
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
                    setParticipants((list) => [
                      ...list,
                      { name: '', model: defaultModel, stance: '' },
                    ])
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
          )}
          {kind === 'work' && options.tools.length > 0 && (
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
                        <span className="truncate text-[12px] text-ink-muted">
                          {tool.description}
                        </span>
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
          )}
          <Field label="交出前要过的关卡" hint="一行一条，最多 5 条，可以不写">
            <textarea
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
              rows={3}
              className={`${field} resize-y`}
              placeholder="如：标题不超过 15 个字"
            />
          </Field>
          {!node && sources.length > 0 && (
            <Field label="接在哪个节点后面" hint="可选，它的产出会交给新节点">
              <select value={after} onChange={(e) => setAfter(e.target.value)} className={field}>
                <option value="">不接，单独放着</option>
                {sources.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <footer className="flex items-center gap-3 border-t border-hairline px-6 py-4">
          <p
            role={error ? 'alert' : undefined}
            className={`m-0 flex-1 text-[12.5px] ${error ? 'text-accent' : 'text-ink-muted'}`}
          >
            {error ??
              problem ??
              (node ? '只改这一个节点，不影响已经跑完的节点。' : '新节点不会自动开跑。')}
          </p>
          <button
            type="submit"
            disabled={busy || problem !== null}
            className="h-10 shrink-0 rounded-full border-0 bg-accent px-5 text-[14px] font-medium text-on-accent disabled:opacity-45"
          >
            {busy ? '正在保存…' : node ? '保存' : '加上'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
