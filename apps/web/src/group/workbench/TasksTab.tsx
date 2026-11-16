// 工作台的「任务」页签：每个 AI 的每个任务一张卡，分进行中、等你确认、完成三栏。聊天里不放干活的
// 过程，过程在这里看：点一张卡，下面展开它的步骤、待办、用时和花费。照原型 ⑥（「待开始」等分工做了才有）。
import { stopGroupAi } from '../../api/queries.ts';
import { ProcessBody } from '../../chat/Process.tsx';
import { elapsedText, useNow } from '../../chat/TaskCard.tsx';
import { AiAvatar } from '../../ui/Avatar.tsx';
import { formatCost } from '../../ui/format.ts';
import { aiLook } from '../people.ts';
import { useRoom } from '../room.ts';
import { TASK_COLUMNS, type RoomTask } from './tasks.ts';
import type { Workbench } from './use-workbench.ts';

function TaskCard({
  task,
  on,
  onPick,
  onFile,
}: {
  task: RoomTask;
  on: boolean;
  onPick: () => void;
  onFile: (path: string) => void;
}) {
  const { models } = useRoom();
  const look = aiLook(models, task.key);
  return (
    <article
      aria-label={`${look.name}：${task.title}`}
      className={`flex flex-col gap-2.5 rounded-bubble bg-bubble p-3.5 ${
        on ? 'shadow-[inset_0_0_0_1.5px_var(--oasis-ink)]' : 'shadow-edge-bright'
      }`}
    >
      <button
        type="button"
        aria-expanded={on}
        onClick={onPick}
        className="flex cursor-pointer flex-col gap-2.5 border-0 bg-transparent p-0 text-left text-ink [font:inherit]"
      >
        <span className="flex items-start gap-2.5">
          <span className="min-w-0 flex-1 break-words text-sm font-medium leading-[1.4]">
            {task.title}
          </span>
          <AiAvatar mono={look.mono} glow={look.glow} size={28} glowing={task.live} />
        </span>
        <span className="break-words text-[12.5px] leading-normal text-ink-muted">{task.note}</span>
        {task.percent !== undefined && (
          <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-track">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${task.percent}%` }}
            />
          </span>
        )}
      </button>
      {task.files.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {task.files.map((file) => (
            <button
              key={file.artifactId}
              type="button"
              onClick={() => onFile(file.path)}
              className="h-[30px] max-w-full cursor-pointer truncate rounded-full border-0 bg-well px-3 text-xs font-medium text-ink"
            >
              {file.name}
            </button>
          ))}
        </span>
      )}
    </article>
  );
}

/** 展开的那个任务：用时、花费、停下或让它继续，下面是过程 */
function TaskProcess({ task }: { task: RoomTask }) {
  const room = useRoom();
  const { group, me, owner, models, busy, act } = room;
  const look = aiLook(models, task.key);
  const now = useNow(task.live);
  const ai = group.ais.find((item) => item.key === task.key);
  const canStop = ai !== undefined && ai.runId === task.runId && (owner || ai.callers.includes(me));
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : undefined;
  return (
    <section
      aria-label={`${look.name} 的过程`}
      className="flex flex-col gap-3 rounded-pop bg-bubble p-5 shadow-edge-bright"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <AiAvatar mono={look.mono} glow={look.glow} size={30} glowing={task.live} />
        <div className="flex min-w-0 flex-[1_1_160px] flex-col">
          <h3 className="m-0 break-words text-[15px] font-medium leading-snug">{task.title}</h3>
          <span className="text-xs text-ink-muted">
            {look.name}
            {(task.live || ended !== undefined) && (
              <>
                {' · 用时 '}
                {elapsedText((ended ?? now) - Date.parse(task.startedAt))}
              </>
            )}
            {task.spentMicro > 0 && (
              <>
                {' · 花费 '}
                <span className="font-display">{formatCost(task.spentMicro)}</span>
              </>
            )}
          </span>
        </div>
        {canStop && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => stopGroupAi(group.id, task.key))}
            className="h-9 cursor-pointer rounded-full border-0 bg-glass-active px-3.5 text-[12.5px] text-ink shadow-edge-strong disabled:opacity-45"
          >
            停下
          </button>
        )}
        {task.column === 'review' && !ai?.runId && (
          <button
            type="button"
            disabled={busy || room.sending}
            onClick={() => void room.send('继续', [{ kind: 'ai', key: task.key }])}
            className="h-9 cursor-pointer rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:opacity-45"
          >
            让它继续
          </button>
        )}
      </header>
      {task.parts.length > 0 || task.todos?.length ? (
        <ProcessBody parts={task.parts} todos={task.todos} live={task.live} />
      ) : (
        <p className="m-0 text-[13px] text-ink-muted">这一轮没有动手做的步骤。</p>
      )}
    </section>
  );
}

export function TasksTab({ bench }: { bench: Workbench }) {
  const focused = bench.tasks.find((task) => task.runId === bench.focus);
  if (!bench.tasks.length)
    return (
      <p className="m-0 flex flex-1 items-center justify-center px-6 text-center text-[13px] leading-relaxed text-ink-muted">
        还没有任务。
        <br />@ 一个 AI 让它做点什么，它动手以后的过程在这里看。
      </p>
    );
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap content-start gap-3">
        {TASK_COLUMNS.map((column) => {
          const tasks = bench.tasks.filter((task) => task.column === column.id);
          return (
            <section
              key={column.id}
              aria-label={column.title}
              className="flex min-w-0 flex-[1_1_180px] flex-col gap-2.5 rounded-pop bg-well px-2.5 pb-2.5 pt-3.5"
            >
              <h3 className="m-0 mx-2 flex items-baseline gap-2 text-sm font-medium leading-[1.3]">
                {column.title}
                <span className="font-display text-xs font-normal text-ink-muted">
                  {tasks.length}
                </span>
              </h3>
              {tasks.map((task) => (
                <TaskCard
                  key={task.runId}
                  task={task}
                  on={task.runId === bench.focus}
                  onPick={() => bench.setFocus(task.runId === bench.focus ? undefined : task.runId)}
                  onFile={bench.openFile}
                />
              ))}
            </section>
          );
        })}
      </div>
      {focused && <TaskProcess task={focused} />}
    </div>
  );
}
