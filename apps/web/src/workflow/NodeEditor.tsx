// 加节点 / 改还没开始的节点：名字、要做的事、角色、模型、关卡、工具（干活节点）、参与者和轮数（讨论节点）
// 或步骤（工具节点，ADR 0025）。
// 新节点先是「新建」状态，不会自动开跑：点节点上的「运行」或工作流的「全部运行」才加入。
import type { NodeBody, PlanNode, TaskBody, UpdateNodeBody } from '@oasis/contracts/task';
import { ToolSteps, type ToolStep } from '@oasis/contracts/tool-step';
import { X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Field,
  field,
  ModelSelect,
  ParticipantsField,
  ToolsField,
  type Options,
  type Participant,
} from './node-editor-parts.tsx';

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

/** 工具节点的步骤：JSON 数组，按契约检查；返回步骤或问题 */
export function parseSteps(text: string): { steps: ToolStep[] } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: '步骤要写成 JSON 数组' };
  }
  const parsed = ToolSteps.safeParse(raw);
  if (parsed.success) return { steps: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    problem: `步骤有问题：${issue?.path.join('.') ? `${issue.path.join('.')} ` : ''}${issue?.message ?? ''}`,
  };
}

const STEPS_EXAMPLE = JSON.stringify(
  [
    {
      tool: 'op.video.concat',
      args: { in: ['in/镜头/1.mp4', 'in/镜头/2.mp4'] },
      out: 'out/成片.mp4',
    },
  ],
  null,
  2,
);

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
  const [kind, setKind] = useState<NodeBody['kind']>(node?.kind ?? 'work');
  const [stepsText, setStepsText] = useState(
    node?.steps ? JSON.stringify(node.steps, null, 2) : STEPS_EXAMPLE,
  );
  const [title, setTitle] = useState(node?.title ?? '');
  const [goal, setGoal] = useState(node?.goal ?? '');
  const [role, setRole] = useState(node?.role ?? '');
  const [model, setModel] = useState(node?.model ?? defaultModel);
  const [checks, setChecks] = useState(
    (node?.checks ?? []).map((c) => (typeof c === 'string' ? c : c.text)).join('\n'),
  );
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
  const steps = kind === 'tool' ? parseSteps(stepsText) : undefined;
  const problem = !title.trim()
    ? '先写个名字'
    : !goal.trim()
      ? '再写下要做的事'
      : checkList.length > 5
        ? '关卡最多 5 条'
        : kind === 'discussion' && (names.some((n) => !n) || new Set(names).size !== names.length)
          ? '参与者要有名字，而且不能重名'
          : steps && 'problem' in steps
            ? steps.problem
            : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (problem) return;
    const common = {
      title: title.trim(),
      goal: goal.trim(),
      role: role.trim(),
      model,
      checks: checkList.map(
        (text) => node?.checks.find((c) => typeof c !== 'string' && c.text === text) ?? text,
      ),
    };
    const toolList = Object.entries(tools).map(([key, uses]) => ({ key, uses }));
    const cleanParticipants = participants.map((p) => ({ ...p, name: p.name.trim() }));
    const toolSteps = steps && 'steps' in steps ? steps.steps : [];
    if (node) {
      onSave({
        changes:
          kind === 'tool'
            ? // 工具节点不用模型：不改模型
              {
                title: common.title,
                goal: common.goal,
                role: common.role,
                checks: common.checks,
                steps: toolSteps,
              }
            : {
                ...common,
                ...(kind === 'work'
                  ? { tools: toolList }
                  : { participants: cleanParticipants, rounds }),
              },
      });
      return;
    }
    const key = keyFor(common.title, new Set(task.nodes.map((n) => n.key)));
    onSave({
      node:
        kind === 'work'
          ? { ...common, key, kind, expects: [], tools: toolList }
          : kind === 'tool'
            ? { ...common, model: '', key, kind, expects: [], steps: toolSteps }
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
                  ['tool', '工具', '不用 AI，按步骤调用工具'],
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
          {kind !== 'tool' && (
            <Field label={kind === 'discussion' ? '谁来写结论' : '用哪个模型'}>
              <ModelSelect value={model} onChange={setModel} options={options} />
            </Field>
          )}
          {kind === 'tool' && (
            <Field
              label="步骤"
              hint="JSON 数组，按顺序执行；参数见工具目录，上游的文件在 in/<上游节点名>/"
            >
              <textarea
                value={stepsText}
                onChange={(e) => setStepsText(e.target.value)}
                rows={8}
                spellCheck={false}
                className={`${field} resize-y font-mono text-[12.5px]`}
              />
            </Field>
          )}
          {kind === 'discussion' && (
            <ParticipantsField
              participants={participants}
              setParticipants={setParticipants}
              rounds={rounds}
              setRounds={setRounds}
              options={options}
              defaultModel={defaultModel}
            />
          )}
          {kind === 'work' && options.tools.length > 0 && (
            <ToolsField tools={tools} setTools={setTools} options={options} />
          )}
          <Field label="交付前自查" hint="节点交付前自己对照，一行一条，最多 5 条，可以不写">
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
