// 画布上点开一个任务：它的全部成品和素材（任务框），能看过程、回到私聊、打包下载。任务还在做时跟着刷新，
// 做好一个就出现。
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useMemo } from 'react';
import { artifactsQuery, tasksQuery } from '../api/queries.ts';
import { groupTasks } from '../canvas/task-groups.ts';
import { TaskPanel, useMakerOf } from '../canvas/TaskPanel.tsx';
import { useNow } from '../chat/TaskCard.tsx';
import { EmptyHint } from '../ui/Panel.tsx';

const route = getRouteApi('/shell/canvas/tasks/$runId');

export function TaskPage() {
  const { runId } = route.useParams();
  const { data: tasks = [], isPending: tasksPending } = useQuery(tasksQuery);
  const running = tasks.some((task) => task.runId === runId && task.status === 'running');
  const { data: artifacts, isPending } = useQuery({
    ...artifactsQuery(),
    refetchInterval: running ? 3_000 : false,
  });
  const makerOf = useMakerOf();
  const now = useNow(running);
  const group = useMemo(
    () =>
      groupTasks({ artifacts: artifacts ?? [], tasks, category: 'all', keyword: '' }).groups.find(
        (g) => g.runId === runId,
      ),
    [artifacts, tasks, runId],
  );

  return (
    <>
      <header className="flex items-center gap-3 px-1.5 pt-1 text-[13.5px] text-ink-muted">
        <Link
          to="/canvas"
          search={{}}
          aria-label="回到画布"
          className="flex size-[42px] items-center justify-center rounded-full bg-glass-strong text-ink shadow-edge-strong"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </Link>
        <span>画布</span>
        <span>/</span>
        <span className="truncate font-medium text-ink">{group?.title ?? '任务'}</span>
      </header>
      {(isPending || tasksPending) && <EmptyHint>正在加载…</EmptyHint>}
      {!isPending && !tasksPending && !group && (
        <EmptyHint>没有这个任务（可能已经删了），回画布看看。</EmptyHint>
      )}
      {group && <TaskPanel group={group} maker={makerOf(group.conversationId)} now={now} />}
    </>
  );
}
