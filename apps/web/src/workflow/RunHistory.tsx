// 节点的运行过程：每次运行一行（第 1 次、关卡没过接着改、停止后继续、讨论里的每次发言），
// 点开看这次 AI 说了什么、做了什么（写了哪些文件、调了哪些工具）、你说了什么。
import type { NodeRunBody } from '@oasis/contracts/task';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FilePen, Terminal, Wrench } from 'lucide-react';
import { useState } from 'react';
import { nodeRunsQuery, runEventsQuery } from '../api/queries.ts';
import { RUN_STATUS, runLabel, stepsOf, type Step } from './rules.ts';

const LIVE: NodeRunBody['status'][] = ['pending', 'running'];

function StepLine({ step, toolName }: { step: Step; toolName: (key: string) => string }) {
  if (step.kind === 'said') {
    return (
      <li className="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-[16px_16px_16px_6px] bg-glass-active px-3 py-2 text-[13px] leading-relaxed shadow-edge-strong">
        {step.text}
      </li>
    );
  }
  if (step.kind === 'you') {
    return (
      <li className="max-w-[92%] self-end whitespace-pre-wrap break-words rounded-[16px_16px_6px_16px] bg-solid px-3 py-2 text-[13px] leading-relaxed text-on-solid">
        {step.text}
      </li>
    );
  }
  if (step.kind === 'error') {
    return <li className="text-[12.5px] text-accent">出错了：{step.text}</li>;
  }
  const Icon = step.tool ? Wrench : step.text.includes('文件') ? FilePen : Terminal;
  return (
    <li className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-muted">
      <Icon size={13} aria-hidden="true" className="shrink-0" />
      <span className={`shrink-0 ${step.tool ? 'font-medium text-ink' : ''}`}>
        {step.tool ? `调用工具「${toolName(step.tool)}」` : step.text}
      </span>
      {step.detail && !step.tool && <span className="min-w-0 truncate">{step.detail}</span>}
      {step.failed && <span className="shrink-0 text-accent">没成功</span>}
    </li>
  );
}

function RunSteps({
  taskId,
  nodeId,
  run,
  toolName,
}: {
  taskId: string;
  nodeId: string;
  run: NodeRunBody;
  toolName: (key: string) => string;
}) {
  const live = LIVE.includes(run.status);
  const { data, isPending, isError } = useQuery(runEventsQuery(taskId, nodeId, run.id, live));
  const steps = stepsOf(data ?? []);
  if (isPending) return <p className="m-0 text-[12.5px] text-ink-muted">正在加载…</p>;
  if (isError) return <p className="m-0 text-[12.5px] text-accent">运行过程没能加载</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {steps.length === 0 && (
        <li className="text-[12.5px] text-ink-muted">
          {live ? 'AI 正在准备…' : '这次没有留下记录'}
        </li>
      )}
      {steps.map((step, index) => (
        <StepLine key={index} step={step} toolName={toolName} />
      ))}
      {run.error && <li className="text-[12.5px] text-accent">{run.error}</li>}
    </ol>
  );
}

export function RunHistory({
  taskId,
  nodeId,
  live,
  toolName,
}: {
  taskId: string;
  nodeId: string;
  /** 节点在动：运行列表跟着刷新 */
  live: boolean;
  toolName: (key: string) => string;
}) {
  const { data: runs = [], isPending } = useQuery(nodeRunsQuery(taskId, nodeId, live));
  // 默认展开最近一次；用户点过的按用户的来
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const last = runs.at(-1)?.id;

  if (isPending) return <p className="m-0 text-[12.5px] text-ink-muted">正在加载…</p>;
  if (runs.length === 0) return <p className="m-0 text-[12.5px] text-ink-muted">还没开始运行。</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {runs.map((run) => {
        const expanded = open[run.id] ?? run.id === last;
        return (
          <li key={run.id} className="flex flex-col gap-2 rounded-item bg-glass-strong px-3 py-2">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen((o) => ({ ...o, [run.id]: !expanded }))}
              className="flex w-full items-center gap-2 border-0 bg-transparent p-0 text-left text-ink"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {runLabel(run)}
              </span>
              <span
                className={`shrink-0 text-[12px] ${
                  run.status === 'failed' ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                {RUN_STATUS[run.status]}
              </span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
            {expanded && <RunSteps taskId={taskId} nodeId={nodeId} run={run} toolName={toolName} />}
          </li>
        );
      })}
    </ul>
  );
}
