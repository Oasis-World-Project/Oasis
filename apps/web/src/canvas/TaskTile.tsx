// 画布首页上的一个任务（小窗口）：封面是它最多 4 个成果的缩略图，下面是任务名、状态、时间、用时、花费、
// 做它的 AI 和成果个数。点开进这个任务的页面看全部成品和素材（不在原地展开）。
import { Link } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { StatusTag } from '../chat/parts.tsx';
import { elapsedText, TASK_STATUS } from '../chat/TaskCard.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { Thumb } from './ArtifactCard.tsx';
import type { TaskGroup } from './task-groups.ts';
import { when, type Maker } from './TaskPanel.tsx';

export function TaskTile({ group, maker, now }: { group: TaskGroup; maker?: Maker; now: number }) {
  const { task } = group;
  const running = task?.status === 'running';
  const status = task ? TASK_STATUS[task.status] : undefined;
  const covers = [...group.finals, ...group.materials].slice(0, 4);
  const at = task ? Date.parse(task.startedAt) : group.at;
  return (
    <Link
      to="/canvas/tasks/$runId"
      params={{ runId: group.runId }}
      aria-label={`打开任务 ${group.title}`}
      className="glass flex min-w-0 flex-col gap-3 rounded-[30px] p-2.5 pb-3.5 text-ink no-underline"
    >
      <span
        className={`relative grid h-[150px] gap-1 overflow-hidden rounded-[22px] bg-glass-strong oasis-dots ${
          covers.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
        } ${covers.length > 2 ? 'grid-rows-2' : 'grid-rows-1'}`}
      >
        {covers.map((artifact, index) => (
          <span
            key={artifact.id}
            className={`relative block overflow-hidden ${covers.length === 3 && index === 0 ? 'row-span-2' : ''}`}
          >
            <Thumb artifact={artifact} />
          </span>
        ))}
        {covers.length === 0 && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
            <FolderOpen size={30} aria-hidden="true" />
            <span className="text-xs">{running ? '还在做，做好一个就放进来' : '没有留下成果'}</span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1.5 px-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{group.title}</span>
          {status && <StatusTag tone={status.tone}>{status.label}</StatusTag>}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-muted">
          {at > 0 && <span>{when(at)}</span>}
          {task && (
            <span>
              · 用时{' '}
              {elapsedText(
                (task.finishedAt ? Date.parse(task.finishedAt) : now) - Date.parse(task.startedAt),
              )}
            </span>
          )}
          {task && <span>· {formatCost(task.spentMicro)}</span>}
        </span>
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          {maker && (
            <>
              <AiAvatar mono={maker.mono} glow={maker.glow} size={18} glowing={running} />
              <span className="truncate">{maker.name}</span>
              <span>·</span>
            </>
          )}
          <span>
            成品 {group.finals.length}
            {group.materials.length > 0 && ` · 素材 ${group.materials.length}`}
          </span>
        </span>
      </span>
    </Link>
  );
}
