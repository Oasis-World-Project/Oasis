// 工作台的「任务」页签。四个一样大的框：待开始、进行中、已完成、修改中；任务是扁扁的一条一条，多了在框里滚，
// 不把框撑长。点一条弹出它的窗（TaskDialog.tsx）。聊天里的任务也是这一条（TaskRow）。照原型 ⑥。
import { AiAvatar } from '../../ui/Avatar.tsx';
import { formatCost } from '../../ui/format.ts';
import { aiLook } from '../people.ts';
import { useRoom } from '../room.ts';
import { TASK_COLUMNS, type RoomTask } from './tasks.ts';
import type { Workbench } from './use-workbench.ts';

/** 一个任务一条：谁做、叫什么、做到哪了；在等人时亮一个红点，在做时底下一条进度 */
export function TaskRow({ task, onOpen }: { task: RoomTask; onOpen: () => void }) {
  const { models } = useRoom();
  const look = aiLook(models, task.key);
  const meta = [task.note, task.spentMicro > 0 ? formatCost(task.spentMicro) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      aria-label={`${look.name}：${task.title}${task.asking ? '，在等人' : ''}`}
      onClick={onOpen}
      className="relative flex min-h-[52px] w-full flex-none cursor-pointer items-center gap-2 overflow-hidden rounded-2xl border-0 bg-bubble px-2.5 py-2 text-left text-ink shadow-edge-bright [font:inherit]"
    >
      <AiAvatar mono={look.mono} glow={look.glow} size={28} glowing={task.live} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[13.5px] font-medium">{task.title}</span>
        <span className="truncate text-[11.5px] text-ink-muted">{meta}</span>
      </span>
      {task.asking && (
        <span
          role="img"
          aria-label="在等人"
          className="size-2.5 flex-none rounded-full bg-accent shadow-[0_0_0_4px_var(--oasis-accent-tint)]"
        />
      )}
      {task.live && task.percent !== undefined && (
        <span
          aria-hidden="true"
          className="absolute inset-x-2.5 bottom-[3px] h-[3px] overflow-hidden rounded-full bg-track"
        >
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${task.percent}%` }}
          />
        </span>
      )}
    </button>
  );
}

export function TasksTab({ bench }: { bench: Workbench }) {
  if (!bench.tasks.length)
    return (
      <p className="m-0 flex flex-1 items-center justify-center px-6 text-center text-[13px] leading-relaxed text-ink-muted">
        还没有任务。
        <br />让 AI 做点什么，它动手做的事在这里一条一条列着。
      </p>
    );
  return (
    <div
      className={`grid min-h-0 flex-1 gap-3 ${
        bench.mode === 'wide' ? 'grid-cols-4 grid-rows-1' : 'grid-cols-2 grid-rows-2'
      }`}
    >
      {TASK_COLUMNS.map((column) => {
        const tasks = bench.tasks.filter((task) => task.column === column.id);
        return (
          <section
            key={column.id}
            aria-label={column.title}
            className="box-border flex min-h-0 min-w-0 flex-col gap-2 rounded-3xl bg-well px-2 pb-2 pt-3"
          >
            <h3 className="m-0 mx-2 flex items-baseline gap-2 text-sm font-medium leading-[1.3]">
              {column.title}
              <span className="font-display text-xs font-normal text-ink-muted">
                {tasks.length}
              </span>
            </h3>
            <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-0.5 pb-0.5">
              {tasks.map((task) => (
                <TaskRow key={task.runId} task={task} onOpen={() => bench.setFocus(task.runId)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
