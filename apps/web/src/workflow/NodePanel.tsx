// 节点详情（照原型 ⑬ 的单节点面板）：谁在做、状态和操作、关卡提醒、要做的事、上下游、
// 工具和花费、产出文件、运行过程；还没开始或正在跑的节点可以追问、补要求。
import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { ArrowUp, Link2Off, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  addEdge,
  deleteEdge,
  deleteNode,
  messageNode,
  runNode,
  stopNode,
  taskFileUrl,
} from '../api/queries.ts';
import { FileChip } from '../chat/FileChip.tsx';
import { FilePreview, type PreviewFile } from '../chat/FilePreview.tsx';
import { ConfirmButton } from '../chat/parts.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { RunHistory } from './RunHistory.tsx';
import { NODE_STATUS, nodeActions } from './rules.ts';
import type { useSpeakers } from './use-speakers.ts';
import type { WorkflowActions } from './use-workflow-actions.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[12px] font-normal text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

const chip =
  'inline-flex h-8 max-w-full items-center gap-1 rounded-full bg-track px-3 text-[12.5px]';
const smallButton =
  'h-8 rounded-full border-0 bg-track px-3 text-[12.5px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40';

/** 上下游：谁交来什么、交给谁；还没开始的节点可以加上游、删连线（拖线之外的另一种接法） */
function Links({
  task,
  node,
  actions,
}: {
  task: TaskBody;
  node: NodeBody;
  actions: WorkflowActions;
}) {
  const titleOf = (id: string | null) => task.nodes.find((n) => n.id === id)?.title ?? '（空）';
  const incoming = task.edges.filter((e) => e.to === node.id);
  const outgoing = task.edges.filter((e) => e.from === node.id);
  const editable = nodeActions(task, node).acceptsInput;
  const busy = actions.busy !== null;
  const candidates = task.nodes.filter(
    (n) =>
      n.id !== node.id &&
      nodeActions(task, n).givesOutput &&
      !incoming.some((e) => e.from === n.id),
  );
  const remove = (edgeId: string) => void actions.run('edge', () => deleteEdge(task.id, edgeId));

  return (
    <>
      <Section title="从上游拿到">
        {incoming.length === 0 && (
          <p className="m-0 text-[13px] text-ink-muted">没有上游，直接从任务开始做。</p>
        )}
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {incoming.map((edge) => {
            const from = task.nodes.find((n) => n.id === edge.from);
            return (
              <li key={edge.id} className={`${chip} ${edge.from ? '' : 'text-accent'}`}>
                {edge.from ? (
                  <span className="truncate">
                    {from?.title}
                    {from && from.outputs.length > 0 && (
                      <span className="text-ink-muted"> · {from.outputs.length} 个文件</span>
                    )}
                  </span>
                ) : (
                  <>
                    <Link2Off size={13} aria-hidden="true" />
                    前面的线断了
                  </>
                )}
                {editable && (
                  <button
                    type="button"
                    onClick={() => remove(edge.id)}
                    disabled={busy}
                    aria-label={`删掉来自${titleOf(edge.from)}的连线`}
                    className="-mr-1.5 flex size-6 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {editable && candidates.length > 0 && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            加一个上游
            <select
              value=""
              disabled={busy}
              onChange={(e) => {
                const from = e.target.value;
                if (from) void actions.run('edge', () => addEdge(task.id, from, node.id));
              }}
              className="h-8 min-w-0 flex-1 rounded-full border-0 bg-glass-active px-3 text-[12.5px] text-ink shadow-edge-strong"
            >
              <option value="">选一个节点…</option>
              {candidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>
      {outgoing.length > 0 && (
        <Section title="交给下游">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {outgoing.map((edge) => (
              <li key={edge.id} className={`${chip} ${edge.to ? '' : 'text-accent'}`}>
                {edge.to ? (
                  <span className="truncate">{titleOf(edge.to)}</span>
                ) : (
                  <>
                    <Link2Off size={13} aria-hidden="true" />
                    后面的线断了
                    <button
                      type="button"
                      onClick={() => remove(edge.id)}
                      disabled={busy}
                      aria-label="删掉断开的连线"
                      className="-mr-1.5 flex size-6 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Ask({
  task,
  node,
  actions,
}: {
  task: TaskBody;
  node: NodeBody;
  actions: WorkflowActions;
}) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const running = node.status === 'running' && node.kind === 'work';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    const result = await actions.run('ask', () => messageNode(task.id, node.id, value));
    if (result) {
      setText('');
      setSent(
        result.result === 'delivered'
          ? '已经告诉它了，它做完手上这一步就会看到。'
          : '记下了，开跑或继续时会带上。',
      );
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-1.5 border-t border-hairline px-4 pb-4 pt-3"
    >
      {sent && (
        <p role="status" className="m-0 text-[12px] text-ink-muted">
          {sent}
        </p>
      )}
      <div className="flex items-center gap-1.5 rounded-full bg-glass-active py-1 pl-4 pr-1 shadow-edge-strong">
        <label htmlFor="node-ask" className="sr-only">
          {running ? '问问这个节点' : '给这个节点补要求'}
        </label>
        <input
          id="node-ask"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(null);
          }}
          disabled={actions.busy !== null}
          placeholder={running ? '问问这个节点，或者补一句要求…' : '补一句要求，开跑时带上…'}
          className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
        />
        <button
          type="submit"
          aria-label="发送"
          disabled={actions.busy !== null || !text.trim()}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-accent text-on-accent disabled:opacity-45"
        >
          <ArrowUp size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

export function NodePanel({
  task,
  node,
  speakers,
  actions,
  onEdit,
  onClose,
}: {
  task: TaskBody;
  node: NodeBody;
  speakers: ReturnType<typeof useSpeakers>;
  actions: WorkflowActions;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const allowed = nodeActions(task, node);
  const status = NODE_STATUS[node.status];
  const who = speakers.speakersOf(node);
  const busy = actions.busy !== null;
  const live = ['running', 'checking'].includes(node.status);
  const toPreview = (file: NodeBody['outputs'][number]): PreviewFile => ({
    path: file.path,
    size: file.size,
    url: taskFileUrl(task.id, node.id, file.path),
    downloadUrl: taskFileUrl(task.id, node.id, file.path, true),
  });
  const statusTone =
    status.tone === 'active' || status.tone === 'trouble'
      ? 'bg-accent/15 text-accent'
      : 'bg-track text-ink-muted';

  return (
    <aside
      aria-label={`节点：${node.title}`}
      className="absolute bottom-4 right-4 top-20 z-20 flex w-[372px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-[28px] bg-glass-active shadow-panel backdrop-blur-2xl"
    >
      <div className="flex flex-col gap-3 px-4 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <span
            className="relative flex shrink-0"
            style={{ width: 40 + (Math.min(who.length, 4) - 1) * 32, height: 40 }}
          >
            {who.slice(0, 4).map((s, i) => (
              <span key={`${s.name}-${i}`} className="absolute top-0" style={{ left: i * 32 }}>
                <AiAvatar mono={s.mono} glow={s.glow} size={40} glowing={live} />
              </span>
            ))}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[17px] font-medium leading-snug">{node.title}</h2>
            <p className="m-0 truncate text-[12.5px] text-ink-muted">
              {node.discussion
                ? `${who.map((s) => s.name).join('、')} 讨论 ${node.discussion.rounds} 轮`
                : `${who[0]?.name ?? node.model}${node.role ? ` · ${node.role}` : ''}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭节点详情"
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-track text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`h-7 rounded-full px-2.5 text-[12px] leading-7 ${statusTone}`}>
            {status.label}
          </span>
          <span className="flex-1" />
          {allowed.run && (
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => void actions.run('node-run', () => runNode(task.id, node.id))}
            >
              {node.status === 'stopped' ? '继续' : node.status === 'failed' ? '再试' : '运行'}
            </button>
          )}
          {allowed.stop && (
            <button
              type="button"
              className={smallButton}
              disabled={busy}
              onClick={() => void actions.run('node-stop', () => stopNode(task.id, node.id))}
            >
              停止
            </button>
          )}
          {allowed.edit && (
            <button type="button" className={smallButton} disabled={busy} onClick={onEdit}>
              编辑
            </button>
          )}
          {allowed.remove && (
            <ConfirmButton
              label="删除"
              question="删掉这个节点？"
              confirmLabel="删除"
              disabled={busy}
              onConfirm={() =>
                void actions
                  .run('node-delete', () => deleteNode(task.id, node.id))
                  .then((r) => r && onClose())
              }
            />
          )}
        </div>
        {node.status === 'succeeded' && (
          <p className="m-0 rounded-item bg-track px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
            已经跑完的节点不能修改、追问或删除。
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {node.warning && (
          <p
            role="note"
            className="m-0 rounded-item bg-accent/10 px-3 py-2 text-[13px] leading-relaxed text-accent"
          >
            关卡提醒：{node.warning}
          </p>
        )}
        <Section title={node.kind === 'discussion' ? '讨论的题目' : '要做的事'}>
          <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {node.goal}
          </p>
        </Section>
        {node.checks.length > 0 && (
          <Section title="交出前要过的关卡">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
              {node.checks.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </Section>
        )}
        <Links task={task} node={node} actions={actions} />
        {node.userNotes.length > 0 && (
          <Section title="你补的要求">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
              {node.userNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Section>
        )}
        {node.discussion && (
          <Section title="谁在讨论">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {node.discussion.participants.map((p) => (
                <li key={p.name} className="text-[13px] leading-relaxed">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-ink-muted"> · {speakers.speakerOf(p.model).name}</span>
                  {p.stance && <span className="block text-ink-muted">{p.stance}</span>}
                </li>
              ))}
            </ul>
            <p className="m-0 text-[13px] text-ink-muted">
              {speakers.speakerOf(node.model).name} 写结论
            </p>
          </Section>
        )}
        <Section title={node.discussion ? '花费' : '工具和花费'}>
          {!node.discussion && (
            <p className="m-0 text-[13px] leading-relaxed">
              {node.tools.length > 0
                ? node.tools
                    .map((t) => `${speakers.toolName(t.key)}（预计 ${t.uses} 次）`)
                    .join('、')
                : '没有分外部工具，只写字、写代码、跑命令。'}
            </p>
          )}
          <p className="m-0 text-[13px] text-ink-muted">
            已花 <span className="font-display text-ink">{formatCost(node.spentMicro)}</span>
            {node.attempts > 1 && ` · 跑了 ${node.attempts} 次`}
            {node.reworks > 0 && ` · 关卡退回 ${node.reworks} 次`}
          </p>
        </Section>
        {node.outputs.length > 0 && (
          <Section title="产出文件">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {node.outputs.map((file) => (
                <FileChip
                  key={file.path}
                  file={toPreview(file)}
                  onOpen={() => setPreview(toPreview(file))}
                />
              ))}
            </ul>
          </Section>
        )}
        {node.discussion && node.discussion.transcript.length > 0 && (
          <Section title="讨论记录">
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {node.discussion.transcript.map((t, i) => (
                <li key={i} className="flex flex-col gap-0.5">
                  <span className="text-[12px] text-ink-muted">
                    第 {t.round} 轮 · {t.name}
                  </span>
                  <p className="m-0 whitespace-pre-wrap rounded-[16px_16px_16px_6px] bg-glass-strong px-3 py-2 text-[13px] leading-relaxed">
                    {t.text}
                  </p>
                </li>
              ))}
            </ol>
          </Section>
        )}
        {node.summary && (
          <Section title="它最后说">
            <p className="m-0 whitespace-pre-wrap text-[13px] leading-relaxed">{node.summary}</p>
          </Section>
        )}
        <Section title="运行过程">
          <RunHistory taskId={task.id} nodeId={node.id} live={live} toolName={speakers.toolName} />
        </Section>
      </div>
      {allowed.message && <Ask task={task} node={node} actions={actions} />}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </aside>
  );
}
