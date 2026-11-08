// 节点详情（照原型 ⑬ 的单节点面板）：谁在做、状态和操作、关卡提醒、要做的事、上下游、
// 工具和花费、产出文件、运行过程；还没开始或正在跑的节点可以追问、补要求。
// 工具节点（ADR 0025）没有 AI：显示齿轮和要执行的步骤，不能追问。
import type { NodeBody, TaskBody } from '@oasis/contracts/task';
import { X } from 'lucide-react';
import { useState } from 'react';
import {
  deleteNode,
  runNode,
  stopNode,
  taskFileUrl,
  applicationReportUrl,
} from '../api/queries.ts';
import { FileChip } from '../chat/FileChip.tsx';
import { FilePreview, type PreviewFile } from '../chat/FilePreview.tsx';
import { ConfirmButton } from '../chat/parts.tsx';
import { TaskDecisions } from '../chat/TaskCard.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { ToolMark } from './NodeCard.tsx';
import { Ask, Links, Section, smallButton } from './node-panel-parts.tsx';
import { RunHistory } from './RunHistory.tsx';
import { nodeState, nodeActions, stepArgs, waitingOn } from './rules.ts';
import type { useSpeakers } from './use-speakers.ts';
import type { WorkflowActions } from './use-workflow-actions.ts';

export function NodePanel({
  task,
  node,
  speakers,
  actions,
  onEdit,
  onClose,
  onPick,
  before,
}: {
  task: TaskBody;
  node: NodeBody;
  /** 看旧版工作流：只读，运行记录只列这一版冻结之前的（ADR 0022） */
  before?: string;
  speakers: ReturnType<typeof useSpeakers>;
  actions: WorkflowActions;
  onEdit: () => void;
  onClose: () => void;
  onPick: (nodeId: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const allowed = nodeActions(task, node);
  const status = nodeState(node);
  const who = speakers.speakersOf(node);
  const busy = actions.busy !== null;
  const live = status.tone === 'active';
  const blockers =
    node.status === 'waiting' || (node.status === 'cancelled' && !node.startedAt)
      ? waitingOn(task, node)
      : [];
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
          {node.kind === 'tool' ? (
            <ToolMark size={40} />
          ) : (
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
          )}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[17px] font-medium leading-snug">{node.title}</h2>
            <p className="m-0 truncate text-[12.5px] text-ink-muted">
              {node.steps
                ? `工具节点 · 不用 AI，按 ${node.steps.length} 步执行`
                : node.discussion
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
          {/* 停下等你处理的节点用下面处理卡片上的「继续」，这里不再放一个意思相同的按钮 */}
          {allowed.run && task.attention?.nodeId !== node.id && (
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
        {/* 关卡只查文件齐不齐、网页和音视频能不能打开（ADR 0017）；没满足的、没查到的记在节点提醒里 */}
        <Section title="检查结果">
          <p className="m-0 text-[13px] font-medium">
            {live && node.status === 'checking'
              ? '检查进行中，尚未生成结果。'
              : node.status === 'succeeded'
                ? node.warning
                  ? '检查过了，有提醒（见下方）。'
                  : '检查通过：交付的文件齐全，能打开。'
                : '尚无检查结果。'}
          </p>
        </Section>
        {task.attention?.nodeId === node.id && <TaskDecisions task={task} compact />}
        {blockers.length > 0 && (
          <Section title={task.status === 'cancelled' ? '取消前的上游依赖' : '等待哪些上游'}>
            <p className="m-0 text-[13px] text-ink-muted">
              本节点尚未运行，需要以下上游先完成；不代表本节点检查失败。
            </p>
            {blockers.map((from, i) => (
              <button
                key={from.id ?? i}
                type="button"
                disabled={!from.id}
                onClick={() => from.id && onPick(from.id)}
                className={`${smallButton} h-auto py-2 text-left`}
              >
                {from.title} · 查看原因
              </button>
            ))}
          </Section>
        )}
        {node.warning && (
          <details className="rounded-item bg-track px-3 py-2 text-[13px]">
            <summary className="cursor-pointer">
              {node.status === 'succeeded' ? '阶段检查备注' : '其他检查记录'}
            </summary>
            <p
              role="note"
              className="mb-0 whitespace-pre-wrap break-words leading-relaxed text-ink-muted"
            >
              关卡提醒：{node.warning}
            </p>
          </details>
        )}
        <Section title={node.kind === 'discussion' ? '讨论的题目' : '要做的事'}>
          <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[13.5px] leading-relaxed">
            {node.goal}
          </p>
        </Section>
        {node.checks.length > 0 && (
          <Section title="交付前自查（节点自己对照）">
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed">
              {node.checks.map((c, i) => (
                <li key={i}>{typeof c === 'string' ? c : c.text}</li>
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
        {node.steps && (
          <Section title="要执行的步骤（每步失败自动重试 2 次）">
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {node.steps.map((step, i) => (
                <li
                  key={i}
                  className="flex flex-col gap-0.5 rounded-item bg-glass-strong px-3 py-2"
                >
                  <span className="text-[13px] font-medium">
                    {i + 1}. {speakers.toolName(step.tool)}
                    <span className="font-normal text-ink-muted"> · {step.tool}</span>
                  </span>
                  <span className="break-all text-[12px] text-ink-muted">
                    {stepArgs(step)}
                    {step.out && ` → ${step.out}`}
                  </span>
                </li>
              ))}
            </ol>
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
            {node.outputs.some((file) => file.path.endsWith('/oasis-app.json')) && (
              <a
                className="text-[13px] text-ink-muted"
                href={applicationReportUrl(task.id, node.id)}
                download
              >
                下载浏览器检查报告（检查结束后可用）
              </a>
            )}
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
          <RunHistory
            taskId={task.id}
            nodeId={node.id}
            live={live}
            toolName={speakers.toolName}
            {...(before ? { before } : {})}
          />
        </Section>
      </div>
      {allowed.message && <Ask task={task} node={node} actions={actions} />}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </aside>
  );
}
