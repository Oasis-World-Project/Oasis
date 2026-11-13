// 任务的工作流：每样成果一个框，点开看详情。可以整体运行或停止、停止或继续一样成果；
// 详情里看 AI 自己列的任务清单和运行过程，追问、补要求。节点和连线不能改。
import type { TaskBody } from '@oasis/contracts/task';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import {
  cancelTask,
  deleteTask,
  runTask,
  stopTask,
  taskQuery,
  taskVersionQuery,
} from '../api/queries.ts';
import { ApiError } from '../api/client.ts';
import { ConfirmButton, RevisingTag } from '../chat/parts.tsx';
import { TaskDecisions } from '../chat/TaskCard.tsx';
import { ChatActionsContext } from '../chat/use-chat-actions.ts';
import { formatCost } from '../ui/format.ts';
import { NodePanel } from '../workflow/NodePanel.tsx';
import { canOperate, taskStatusOf } from '../workflow/rules.ts';
import { useProgress } from '../workflow/use-progress.ts';
import { useSpeakers } from '../workflow/use-speakers.ts';
import { useWorkflowActions } from '../workflow/use-workflow-actions.ts';
import { WorkflowGraph } from '../workflow/WorkflowGraph.tsx';

const route = getRouteApi('/shell/canvas/tasks/$taskId');

const pill =
  'inline-flex h-10 items-center gap-1.5 rounded-full border-0 px-4 text-[13.5px] font-medium disabled:cursor-not-allowed disabled:opacity-45';

export function WorkflowPage() {
  const { taskId } = route.useParams();
  const router = useRouter();
  const { data: task, isPending, isError } = useQuery(taskQuery(taskId));
  const speakers = useSpeakers();
  const actions = useWorkflowActions(taskId);
  const queryClient = useQueryClient();
  // 删除任务：还在做的会先停下；删完回画布，不再拉这个任务
  const remove = useMutation({
    mutationFn: () => deleteTask(taskId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: taskQuery(taskId).queryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      await router.navigate({ to: '/canvas' });
    },
  });
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  // 看冻结的旧版工作流：null 是当前这一版
  const [viewing, setViewing] = useState<number | null>(null);
  const frozen = useQuery({ ...taskVersionQuery(taskId, viewing ?? 1), enabled: viewing !== null });
  // 旧版只读：照冻结时的节点和连线
  const old = viewing !== null ? frozen.data : undefined;
  const progress = useProgress(taskId, old?.nodes ?? task?.nodes, old?.frozenAt);

  if (isPending || isError) {
    return (
      <section
        aria-label="工作流"
        className="glass flex h-[calc(100vh-44px)] items-center justify-center rounded-panel"
      >
        <p className="m-0 text-sm text-ink-muted">
          {isError ? '没找到这个任务。' : '正在加载工作流…'}
        </p>
      </section>
    );
  }

  // 旧版按已结束的任务显示（不能运行、处理）
  const shown: TaskBody = old
    ? {
        ...task,
        status: 'succeeded',
        attention: null,
        revision: null,
        revising: false,
        acceptance: null,
        nodes: old.nodes,
        edges: old.edges,
        spentMicro: old.spentMicro,
      }
    : task;
  const pickVersion = (version: number | null) => {
    setViewing(version);
    setSelected(null);
  };
  const selectedId = selected === undefined ? (shown.attention?.nodeId ?? null) : selected;
  const node = shown.nodes.find((n) => n.id === selectedId);
  // 已经挑好一版的节点下面没做成的那几版不算问题；展开出来的条目、各版算在父节点里
  const settledUnder = (n: (typeof shown.nodes)[number]) =>
    shown.nodes.find((p) => p.id === n.parentId)?.status === 'succeeded';
  const issues = shown.nodes.filter(
    (n) =>
      !settledUnder(n) &&
      ((n.status !== 'succeeded' && n.warning) ||
        n.status === 'failed' ||
        n.status === 'stopped' ||
        shown.attention?.nodeId === n.id),
  );
  const steps = shown.nodes.filter((n) => !n.parentId);
  const done = steps.filter((n) => n.status === 'succeeded').length;
  const open = canOperate(shown);
  const status = taskStatusOf(task);
  const busy = actions.busy !== null;
  const back = () =>
    window.history.length > 1 ? router.history.back() : void router.navigate({ to: '/canvas' });

  return (
    // 「需要处理」的选择和私聊里的任务卡共用一个组件，它要的操作上下文在这里给
    <ChatActionsContext.Provider
      value={{
        conversationId: '',
        busy: actions.busy,
        error: actions.error,
        run: async (name, action) => {
          await actions.run(name, action);
        },
        focusComposer: () => undefined,
      }}
    >
      <section
        aria-label="工作流"
        className="relative h-[calc(100vh-44px)] min-h-[560px] overflow-hidden rounded-panel bg-glass-strong shadow-[var(--oasis-glass-edge),var(--oasis-shadow-panel)]"
      >
        {viewing !== null && !old ? (
          <div className="flex h-full items-center justify-center">
            <p className="m-0 text-sm text-ink-muted">
              {frozen.isError ? '这一版没能加载。' : '正在加载这一版…'}
            </p>
          </div>
        ) : task.status === 'planning' && task.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="m-0 text-[15px] font-medium">AI 团队正在搭建工作流</p>
            <p className="m-0 text-sm text-ink-muted">排好后，每样成果会出现在这里。</p>
          </div>
        ) : (
          <ReactFlowProvider>
            <WorkflowGraph
              task={shown}
              selected={selectedId}
              speakers={speakers}
              progress={progress}
              onPick={setSelected}
            />
          </ReactFlowProvider>
        )}

        {/* 左上：返回、标题、状态 */}
        <div className="absolute left-4 top-4 z-10 flex max-w-[calc(100%-32px)] items-center gap-2.5 rounded-full bg-glass-active py-1.5 pl-1.5 pr-4 shadow-edge-strong backdrop-blur-xl">
          <button
            type="button"
            onClick={back}
            aria-label="返回"
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-track text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <h1 className="m-0 min-w-0 truncate text-[15px] font-medium">{task.title} 的工作流</h1>
          {task.revising && !old && <RevisingTag />}
          <span className="shrink-0 text-[12.5px] text-ink-muted">
            {old ? `第 ${old.version} 版 · 只读` : status.label}
          </span>
        </div>

        {/* 右上：进度、花费、整体运行 / 停止、取消 */}
        <div className="absolute right-4 top-4 z-10 flex flex-wrap items-center justify-end gap-1.5">
          <span className="inline-flex h-10 items-center gap-2 rounded-full bg-glass-active px-4 text-[13px] shadow-edge-strong backdrop-blur-xl">
            <span className="font-display">
              {done} / {steps.length}
            </span>
            完成
            <span className="text-ink-muted">· 已花 {formatCost(shown.spentMicro)}</span>
          </span>
          {open && (
            <>
              {task.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void actions.run('stop', () => stopTask(taskId))}
                  disabled={busy}
                  className={`${pill} bg-solid text-on-solid`}
                >
                  全部停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void actions.run('run', () => runTask(taskId))}
                  disabled={busy}
                  className={`${pill} bg-accent text-on-accent`}
                >
                  全部运行
                </button>
              )}
              <ConfirmButton
                label="取消任务"
                question="取消后不能恢复，确定吗？"
                confirmLabel="取消任务"
                disabled={busy}
                onConfirm={() => void actions.run('cancel', () => cancelTask(taskId))}
              />
            </>
          )}
          <ConfirmButton
            label="删除任务"
            question={
              ['succeeded', 'failed', 'cancelled'].includes(task.status)
                ? '连同工作流和成果一起删，不能恢复？'
                : '会先停下，再连同工作流删掉，不能恢复？'
            }
            confirmLabel="删除"
            disabled={busy || remove.isPending}
            onConfirm={() => remove.mutate()}
          />
          {remove.isError && (
            <p
              role="alert"
              className="m-0 basis-full rounded-item bg-glass-active px-4 py-2.5 text-right text-[13px] text-accent shadow-edge-strong"
            >
              {remove.error instanceof ApiError ? remove.error.message : '没删掉，请重试'}
            </p>
          )}
        </div>

        {/* 修改时规划员在看上一版排方案：工作流照旧显示，可以不改了 */}
        {task.revision?.stage === 'planning' && !old && (
          <div className="absolute left-1/2 top-20 z-10 flex w-[min(440px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-item bg-glass-active px-4 py-3 shadow-edge-strong backdrop-blur-xl">
            <p role="status" className="m-0 min-w-0 flex-1 text-[13px] leading-relaxed">
              AI 团队在看上一版，决定这次怎么改。排好后先给你确认再开跑。
            </p>
            <button
              type="button"
              onClick={() => void actions.run('cancel', () => cancelTask(taskId))}
              disabled={busy}
              className={`${pill} shrink-0 bg-track text-ink`}
            >
              不改了
            </button>
          </div>
        )}

        {/* 版本切换：改过的任务能回看之前的工作流（只读） */}
        {task.versions.length > 0 && (
          <div
            role="tablist"
            aria-label="工作流版本"
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-glass-strong p-1 shadow-edge-strong backdrop-blur-xl"
          >
            {[...task.versions.map((v) => v.version), null].map((version) => {
              const active = viewing === version;
              return (
                <button
                  key={version ?? 'current'}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => pickVersion(version)}
                  title={
                    version === null
                      ? undefined
                      : (task.versions.find((v) => v.version === version)?.request ??
                        '最初的工作流')
                  }
                  className={`h-8 rounded-full border-0 px-3.5 text-[12.5px] ${
                    active
                      ? 'bg-solid font-medium text-on-solid'
                      : 'bg-transparent text-ink-muted hover:text-ink'
                  }`}
                >
                  第 {version ?? task.version} 版{version === null ? '（当前）' : ''}
                </button>
              );
            })}
          </div>
        )}

        {/* 需要处理 / 出错提示 */}
        {(issues.length > 0 || shown.status === 'needs_attention' || actions.error) && (
          <div className="absolute left-4 top-20 z-10 max-h-[calc(100%-112px)] w-[min(280px,calc(100%-32px))] overflow-y-auto overscroll-contain">
            {actions.error && (
              <p
                role="alert"
                className="m-0 mb-2 rounded-item bg-glass-active px-4 py-2.5 text-[13px] text-accent shadow-edge-strong"
              >
                {actions.error}
              </p>
            )}
            {issues.length > 0 && (
              <section
                aria-label="待查看的节点"
                className="mb-2 flex flex-col gap-2 rounded-item bg-glass-active p-3 shadow-edge-strong"
              >
                <h2 className="m-0 text-[13px] font-medium">
                  {shown.status === 'cancelled' ? '取消前的检查记录' : '需要查看的节点'}
                </h2>
                {issues.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    aria-label={`查看节点记录：${n.title}`}
                    onClick={() => setSelected(n.id)}
                    className="flex flex-col gap-1 rounded-item border-0 bg-track px-3 py-2 text-left text-[12px] text-ink"
                  >
                    <span className="line-clamp-2">{n.title}</span>
                    <span className="text-ink-muted">
                      {n.status === 'failed'
                        ? '执行失败 · 查看运行记录'
                        : n.status === 'stopped'
                          ? '执行已停止 · 查看运行记录'
                          : shown.attention?.nodeId === n.id
                            ? '需要处理 · 查看原因'
                            : '有提醒 · 查看'}
                    </span>
                  </button>
                ))}
                <p className="m-0 text-[12px] text-ink-muted">
                  {shown.status === 'cancelled'
                    ? '任务已取消，检查记录仍可查看。'
                    : '后续节点需等待上游完成，并非每个节点都检查失败。'}
                </p>
              </section>
            )}
            {/* 节点上的事在节点里处理：点开停下的节点才有「继续」（2026-11-05 用户要求） */}
            {!shown.attention?.nodeId && <TaskDecisions task={shown} compact />}
          </div>
        )}

        {node && (
          <NodePanel
            task={shown}
            node={node}
            {...(old ? { before: old.frozenAt } : {})}
            speakers={speakers}
            progress={progress.get(node.id)}
            actions={actions}
            onPick={setSelected}
            onClose={() => setSelected(null)}
          />
        )}
      </section>
    </ChatActionsContext.Provider>
  );
}
