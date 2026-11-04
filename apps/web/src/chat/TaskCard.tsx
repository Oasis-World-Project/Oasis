// 私聊保留一张任务状态卡与工作流入口；具体检查与处理选择在工作流。
// 任务还在动时每 2.5 秒刷新；状态一变就刷新消息以读取最终交付。
import type { RemovedMark } from '@oasis/contracts/conversation';
import type { Attention, NodeStatus, TaskBody, TaskStatus } from '@oasis/contracts/task';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Workflow } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  cancelTask,
  decideTask,
  messagesQuery,
  runTask,
  SETTLED_STATUSES,
  stopTask,
  taskQuery,
} from '../api/queries.ts';
import { formatCost } from '../ui/format.ts';
import { TASK_STATUS } from '../workflow/rules.ts';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  ConfirmButton,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { useChatActions } from './use-chat-actions.ts';

const NODE_STATUS: Record<NodeStatus, string> = {
  draft: '新建',
  waiting: '等待',
  running: '运行中',
  checking: '检查中',
  succeeded: '完成',
  failed: '失败',
  stopped: '已停止',
  blocked: '断开',
  cancelled: '已取消',
};

/** 进度环：value 在 0–1；spinning 时转一段弧（还不知道有几步） */
function Ring({
  value,
  spinning = false,
  size = 52,
}: {
  value: number;
  spinning?: boolean;
  size?: number;
}) {
  const r = size / 2 - 3;
  const length = 2 * Math.PI * r;
  const shown = spinning ? 0.28 : Math.max(0, Math.min(1, value));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={spinning ? 'motion-safe:animate-spin' : undefined}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={3}
        className="stroke-track"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${shown * length} ${length}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="stroke-accent transition-[stroke-dasharray] duration-500"
      />
    </svg>
  );
}

/** 节点的状态点：在跑的转圈，完成的实心，出问题的珊瑚色 */
function NodeChip({ title, status }: { title: string; status: NodeStatus }) {
  const active = status === 'running' || status === 'checking';
  const done = status === 'succeeded';
  const trouble = status === 'failed' || status === 'blocked';
  return (
    <li
      className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] ${
        done ? 'bg-glass-active text-ink' : 'bg-glass-active/60 text-ink-muted'
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${
          trouble
            ? 'bg-accent'
            : done
              ? 'bg-solid'
              : active
                ? 'border-[1.5px] border-accent motion-safe:animate-pulse'
                : 'border-[1.5px] border-ink-muted/50'
        }`}
      />
      <span className={`max-w-[9em] truncate ${active ? 'text-ink' : ''}`}>{title}</span>
      <span className="sr-only">：{NODE_STATUS[status]}</span>
    </li>
  );
}

type Choice = 'continue' | 'retry' | 'cancel';

/** 每种「需要处理」能做的选择（和 task 的规则一致，见 ADR 0004 / 0005） */
const DECISIONS: Record<
  Attention['reason'],
  { choice: Exclude<Choice, 'cancel'>; label: string }[]
> = {
  node_failed: [
    // 节点中途断了（多半是网络）：从断的地方接着做（2026-11-05 用户要求中断了就叫「继续」）
    { choice: 'retry', label: '继续' },
    { choice: 'continue', label: '跳过这个节点' },
  ],
  over_budget: [{ choice: 'continue', label: '解除预算继续' }],
  over_estimate: [{ choice: 'continue', label: '解除预算继续' }],
  plan_failed: [{ choice: 'retry', label: '重新规划' }],
  workflow_broken: [],
  // 检查中途停下：「继续」从停下的地方接着检查，「跳过检查」不再检查直接往下（2026-11-05 用户要求）
  checks_incomplete: [
    { choice: 'retry', label: '继续' },
    { choice: 'continue', label: '跳过检查' },
  ],
};

/** 处理卡片上直接显示的原因最多这么多字，再长折叠起来 */
const BRIEF_CHARS = 120;

/** 工作流需要处理时的说明和选择。 */
export function TaskDecisions({
  task,
  compact = false,
  showReason = true,
}: {
  task: TaskBody;
  compact?: boolean;
  showReason?: boolean;
}) {
  const actions = useChatActions();
  const { attention } = task;
  if (task.status !== 'needs_attention' || !attention) return null;
  const first = attention.message.split('\n')[0]!;
  const long = attention.message.includes('\n') || first.length > BRIEF_CHARS;
  const brief = first.length > BRIEF_CHARS ? `${first.slice(0, BRIEF_CHARS)}…` : first;
  const busy = actions.busy !== null;
  return (
    <div className="flex flex-col gap-2.5 rounded-item bg-glass-active px-4 py-3 shadow-edge-strong">
      {compact ? (
        <>
          <p role="status" className="m-0 text-[14px] font-medium leading-relaxed">
            {attention.reason === 'checks_incomplete' ? '检查停下了' : '任务需要处理'}
          </p>
          {/* 原因的第一句直接显示；很长或有多行时，完整原因折叠在下面 */}
          <p className="m-0 text-[13px] leading-relaxed text-ink-muted">{brief}</p>
          {showReason && long && (
            <details key={attention.message}>
              <summary className="cursor-pointer text-[13px] text-ink-muted">查看详细原因</summary>
              <p className="m-0 mt-2 max-h-[32vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                {attention.message}
              </p>
            </details>
          )}
        </>
      ) : (
        <p role="status" className="m-0 text-[14px] leading-relaxed">
          {attention.message}
        </p>
      )}
      {attention.reason === 'workflow_broken' && (
        <p className="m-0 text-[12.5px] text-ink-muted">工作流里有连线断开了，接好之后再运行。</p>
      )}
      <CardActions>
        {DECISIONS[attention.reason].map(({ choice, label }, index) => (
          <CardButton
            key={choice}
            tone={index === 0 ? 'accent' : 'plain'}
            onClick={() => void actions.run(`decide-${choice}`, () => decideTask(task.id, choice))}
            disabled={busy}
          >
            {label}
          </CardButton>
        ))}
        <ConfirmButton
          label="取消任务"
          question="取消后不能恢复，确定吗？"
          confirmLabel="取消任务"
          onConfirm={() => void actions.run('decide-cancel', () => decideTask(task.id, 'cancel'))}
          disabled={busy}
        />
      </CardActions>
    </div>
  );
}

function Spend({ task }: { task: TaskBody }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-ink-muted">
      <span>
        已花 <span className="font-display text-ink">{formatCost(task.spentMicro)}</span>
      </span>
      {task.estimateMicro !== null && task.status !== 'succeeded' && (
        <span>预计约 {formatCost(task.estimateMicro)}</span>
      )}
    </p>
  );
}

/**
 * 状态一变（做完了、需要处理了）就刷新消息：交付消息和提醒是 task 发事件、conversation 收到后才写进来的，
 * 会比状态晚一点到，所以过几秒再各刷一次。
 */
const MESSAGE_REFRESH_DELAYS = [0, 2_000, 6_000];

function useRefreshMessagesOnChange(conversationId: string, status: TaskStatus | undefined) {
  const queryClient = useQueryClient();
  const last = useRef(status);
  useEffect(() => {
    const changed = last.current !== undefined && status !== last.current;
    last.current = status;
    if (!changed) return;
    const timers = MESSAGE_REFRESH_DELAYS.map((delay) =>
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: messagesQuery(conversationId).queryKey });
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [conversationId, queryClient, status]);
}

function Progress({ task }: { task: TaskBody }) {
  const total = task.nodes.length;
  const done = task.nodes.filter((n) => n.status === 'succeeded').length;
  const planning = task.status === 'planning';
  return (
    <div className="flex items-center gap-3.5">
      <span className="relative flex size-[52px] shrink-0 items-center justify-center">
        <span className="absolute inset-0">
          <Ring value={total ? done / total : 0} spinning={planning} />
        </span>
        {!planning && (
          <span className="font-display text-[13px] tracking-[-0.03em]">
            {done}/{total}
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-medium">
          {planning
            ? '正在搭建工作流'
            : task.status === 'accepting'
              ? '都做完了，正在对照任务单验收'
              : `${total} 个步骤，完成了 ${done} 个`}
        </span>
        <span className="text-[12.5px] text-ink-muted">
          {planning
            ? 'AI 团队在排分工和顺序，需要一点时间'
            : task.status === 'needs_attention'
              ? '有待处理项，请到工作流查看'
              : task.status === 'stopped'
                ? '已停止，可到工作流查看进度'
                : 'AI 团队按分工在做'}
        </span>
      </div>
    </div>
  );
}

/** 任务被删除后留下的卡片只剩一句话（ADR 0012） */
export function RemovedNote({ removed }: { removed: RemovedMark }) {
  return (
    <p className="m-0 text-[13.5px] text-ink-muted">
      {removed.replacedBy
        ? '这一版已被修改后的新版替换，旧版本不保留。'
        : '这个任务和它的成果已删除。'}
    </p>
  );
}

export function TaskCard({
  taskId,
  speaker,
  revision = false,
  removed,
}: {
  taskId: string;
  speaker: Speaker;
  /** 这是对某个成果的修改 */
  revision?: boolean;
  /** 任务已被删除或替换：不再查询，只留一句话 */
  removed?: RemovedMark;
}) {
  const actions = useChatActions();
  const {
    data: task,
    isPending,
    isError,
  } = useQuery({
    ...taskQuery(taskId),
    enabled: !removed,
  });
  useRefreshMessagesOnChange(actions.conversationId, task?.status);
  const kind = revision ? '修改' : '任务';

  if (removed) {
    return (
      <CardFrame speaker={speaker} label={kind} dim>
        <CardHeading kind={kind} />
        <RemovedNote removed={removed} />
      </CardFrame>
    );
  }

  if (isPending || isError) {
    return (
      <CardFrame speaker={speaker} label={kind}>
        <CardHeading kind={kind} />
        <p className="m-0 text-sm text-ink-muted">
          {isError ? '任务信息没能加载，稍后会再试。' : '正在加载任务…'}
        </p>
      </CardFrame>
    );
  }

  const status = TASK_STATUS[task.status];
  const busy = actions.busy !== null;
  const settled = SETTLED_STATUSES.has(task.status);
  const moving = ['planning', 'running', 'accepting'].includes(task.status);

  return (
    <CardFrame speaker={speaker} label={`${kind}：${task.title}`} glowing={moving}>
      <CardHeading
        kind={kind}
        title={task.title}
        status={<StatusTag tone={status.tone}>{status.label}</StatusTag>}
      />
      {!settled && <Progress task={task} />}
      {task.nodes.length > 0 && !settled && (
        <ul aria-label="步骤" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {task.nodes.map((node) => (
            <NodeChip key={node.id} title={node.title} status={node.status} />
          ))}
        </ul>
      )}
      {task.status === 'needs_attention' && (
        <p className="m-0 text-[13.5px] text-ink-muted">有待处理项，请到工作流查看对应节点。</p>
      )}
      <Spend task={task} />
      <CardActions>
        <Link
          to="/canvas/tasks/$taskId"
          params={{ taskId: task.id }}
          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
        >
          <Workflow size={15} aria-hidden="true" />
          看工作流
        </Link>
        {task.status === 'running' && (
          <CardButton
            onClick={() => void actions.run('stop', () => stopTask(task.id))}
            disabled={busy}
          >
            停止
          </CardButton>
        )}
        {task.status === 'stopped' && (
          <CardButton
            tone="accent"
            onClick={() => void actions.run('run', () => runTask(task.id))}
            disabled={busy}
          >
            继续
          </CardButton>
        )}
        {(task.status === 'running' || task.status === 'stopped') && (
          <ConfirmButton
            label="取消任务"
            question="取消后不能恢复，确定吗？"
            confirmLabel="取消任务"
            onConfirm={() => void actions.run('cancel-task', () => cancelTask(task.id))}
            disabled={busy}
          />
        )}
      </CardActions>
    </CardFrame>
  );
}
