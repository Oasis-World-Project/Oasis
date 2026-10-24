// 任务的工作流（照原型 ⑬）：节点图 + 单个节点的详情。可以整体运行或停止、单独运行或停止一个节点，
// 加节点、删节点、接线、改节点；节点详情里看运行过程、追问、补要求（ADR 0007 §6）。
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useRouter } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  addEdge,
  addNode,
  cancelTask,
  deleteEdge,
  runTask,
  stopTask,
  taskQuery,
  updateEdge,
  updateNode,
} from '../api/queries.ts';
import { ConfirmButton } from '../chat/parts.tsx';
import { TaskDecisions } from '../chat/TaskCard.tsx';
import { ChatActionsContext } from '../chat/use-chat-actions.ts';
import { formatCost } from '../ui/format.ts';
import { NodeEditor, type EditorResult } from '../workflow/NodeEditor.tsx';
import { NodePanel } from '../workflow/NodePanel.tsx';
import { canEditWorkflow } from '../workflow/rules.ts';
import { useSpeakers } from '../workflow/use-speakers.ts';
import { useWorkflowActions } from '../workflow/use-workflow-actions.ts';
import { WorkflowGraph, type GraphHandlers } from '../workflow/WorkflowGraph.tsx';

const route = getRouteApi('/shell/canvas/tasks/$taskId');

const TASK_STATUS: Record<string, string> = {
  planning: '正在搭建工作流',
  running: '进行中',
  accepting: '正在验收',
  stopped: '已停止',
  needs_attention: '需要你处理',
  succeeded: '已完成',
  failed: '没能完成',
  cancelled: '已取消',
};

const pill =
  'inline-flex h-10 items-center gap-1.5 rounded-full border-0 px-4 text-[13.5px] font-medium disabled:cursor-not-allowed disabled:opacity-45';

export function WorkflowPage() {
  const { taskId } = route.useParams();
  const router = useRouter();
  const { data: task, isPending, isError } = useQuery(taskQuery(taskId));
  const speakers = useSpeakers();
  const actions = useWorkflowActions(taskId);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | string | null>(null);

  const handlers = useMemo<GraphHandlers>(
    () => ({
      onPick: setSelected,
      onConnect: (from, to) => {
        // 有断开的线头就接上它，没有就新拉一条
        const loose =
          task?.edges.find((e) => e.from === from && !e.to) ??
          task?.edges.find((e) => !e.from && e.to === to);
        void actions.run('edge', () =>
          loose
            ? updateEdge(taskId, loose.id, loose.from ? { to } : { from })
            : addEdge(taskId, from, to),
        );
      },
      onDeleteEdge: (edgeId) => void actions.run('edge', () => deleteEdge(taskId, edgeId)),
    }),
    [actions, task?.edges, taskId],
  );

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

  const node = task.nodes.find((n) => n.id === selected);
  const editingNode =
    editing && editing !== 'new' ? task.nodes.find((n) => n.id === editing) : undefined;
  const done = task.nodes.filter((n) => n.status === 'succeeded').length;
  const open = canEditWorkflow(task);
  const busy = actions.busy !== null;
  const hasDrafts = task.nodes.some((n) => n.status === 'draft');
  const back = () =>
    window.history.length > 1 ? router.history.back() : void router.navigate({ to: '/canvas' });

  async function save(result: EditorResult) {
    if (result.changes && editingNode) {
      const changes = result.changes;
      if (await actions.run('save', () => updateNode(taskId, editingNode.id, changes)))
        setEditing(null);
      return;
    }
    if (!result.node) return;
    const created = await actions.run('save', () => addNode(taskId, result.node!));
    if (!created) return;
    const added = created.nodes.find((n) => n.key === result.node!.key);
    setEditing(null);
    if (added) {
      setSelected(added.id);
      if (result.after) await actions.run('edge', () => addEdge(taskId, result.after!, added.id));
    }
  }

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
        {task.status === 'planning' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="m-0 text-[15px] font-medium">AI 团队正在搭建工作流</p>
            <p className="m-0 text-sm text-ink-muted">排好分工和顺序后，节点会出现在这里。</p>
          </div>
        ) : (
          <ReactFlowProvider>
            <WorkflowGraph
              task={task}
              selected={selected}
              speakers={speakers}
              handlers={handlers}
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
          <span className="shrink-0 text-[12.5px] text-ink-muted">{TASK_STATUS[task.status]}</span>
        </div>

        {/* 右上：进度、花费、整体运行 / 停止、加节点、取消 */}
        <div className="absolute right-4 top-4 z-10 flex flex-wrap items-center justify-end gap-1.5">
          <span className="inline-flex h-10 items-center gap-2 rounded-full bg-glass-active px-4 text-[13px] shadow-edge-strong backdrop-blur-xl">
            <span className="font-display">
              {done} / {task.nodes.length}
            </span>
            完成
            <span className="text-ink-muted">· 已花 {formatCost(task.spentMicro)}</span>
          </span>
          {open && (
            <>
              <button
                type="button"
                onClick={() => setEditing('new')}
                // 模型和工具的目录还没拿到时打不开编辑窗
                disabled={busy || !speakers.options}
                className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
              >
                <Plus size={15} aria-hidden="true" />
                加节点
              </button>
              {task.status === 'running' ? (
                <>
                  {hasDrafts && (
                    <button
                      type="button"
                      onClick={() => void actions.run('run', () => runTask(taskId))}
                      disabled={busy}
                      className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
                    >
                      把新节点加进来
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void actions.run('stop', () => stopTask(taskId))}
                    disabled={busy}
                    className={`${pill} bg-solid text-on-solid`}
                  >
                    全部停止
                  </button>
                </>
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
        </div>

        {/* 需要处理 / 出错提示 */}
        {(task.status === 'needs_attention' || (actions.error && editing === null)) && (
          <div className="absolute left-1/2 top-20 z-10 w-[min(480px,calc(100%-32px))] -translate-x-1/2">
            {actions.error && editing === null && (
              <p
                role="alert"
                className="m-0 mb-2 rounded-item bg-glass-active px-4 py-2.5 text-[13px] text-accent shadow-edge-strong"
              >
                {actions.error}
              </p>
            )}
            <TaskDecisions task={task} />
          </div>
        )}

        {node && (
          <NodePanel
            task={task}
            node={node}
            speakers={speakers}
            actions={actions}
            onEdit={() => setEditing(node.id)}
            onClose={() => setSelected(null)}
          />
        )}

        {editing !== null && speakers.options && (
          <NodeEditor
            task={task}
            node={editingNode}
            options={speakers.options}
            busy={actions.busy === 'save'}
            error={actions.error}
            onSave={(r) => void save(r)}
            onClose={() => {
              setEditing(null);
              actions.clearError();
            }}
          />
        )}
      </section>
    </ChatActionsContext.Provider>
  );
}
