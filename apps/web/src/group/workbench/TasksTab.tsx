// 工作台的「任务」页签：每个 AI 的每个任务一张卡，分待开始、进行中、等你确认、完成四栏。聊天里不放干活的
// 过程，过程在这里看：点一张卡，下面展开它的步骤、待办、用时和花费。照原型 ⑥。
// 分工单里的一项还能在这里改：改派、改要求、撤掉，或整份全部停下（原型里没有，照这里已有按钮的样子做）。
import type { AssignEditBody } from '@oasis/contracts/group';
import { useState } from 'react';
import { editAssign, stopGroupAi } from '../../api/queries.ts';
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
          <span className="line-clamp-3 min-w-0 flex-1 break-words text-sm font-medium leading-[1.4]">
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

const QUIET =
  'h-9 cursor-pointer rounded-full border-0 bg-glass-active px-3.5 text-[12.5px] text-ink shadow-edge-strong disabled:opacity-45';

/**
 * 分工单里还没结束的一项能做的改动：改派（换一个 AI）、改要求、撤掉——正在做的会先停下那个 AI 的这一轮；
 * 或者整份全部停下。群主和叫它做这件事的人才看得到。
 */
function PlanActions({ plan }: { plan: NonNullable<RoomTask['plan']> }) {
  const { group, models, busy, act } = useRoom();
  const [mode, setMode] = useState<'pick' | 'write'>();
  const [draft, setDraft] = useState(plan.item.task);
  const running = plan.item.status === 'running';
  // 发单的 AI 自己做的不进分工单，所以不在可选的里面
  const others = group.ais.filter((ai) => ai.key !== plan.item.key && ai.key !== plan.lead);
  const edit = (change: AssignEditBody) =>
    void act(() => editAssign(group.id, plan.messageId, change)).then(() => setMode(undefined));
  return (
    <div role="group" aria-label="改这一项" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-expanded={mode === 'pick'}
          disabled={busy || !others.length}
          onClick={() => setMode(mode === 'pick' ? undefined : 'pick')}
          className={QUIET}
        >
          {running ? '停下并改派' : '改派'}
        </button>
        {!running && (
          <button
            type="button"
            aria-expanded={mode === 'write'}
            disabled={busy}
            onClick={() => setMode(mode === 'write' ? undefined : 'write')}
            className={QUIET}
          >
            改要求
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => edit({ op: 'drop', item: plan.item.id })}
          className={QUIET}
        >
          {running ? '停下并撤掉' : '撤掉'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => edit({ op: 'close' })}
          className="ml-auto h-9 cursor-pointer rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted hover:text-ink disabled:opacity-45"
        >
          整份单子全部停下
        </button>
      </div>
      {mode === 'pick' && (
        <ul aria-label="改派给谁" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {others.map((ai) => {
            const look = aiLook(models, ai.key);
            return (
              <li key={ai.key}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => edit({ op: 'reassign', item: plan.item.id, key: ai.key })}
                  className="flex h-9 cursor-pointer items-center gap-2 rounded-full border-0 bg-well pl-1 pr-3.5 text-[12.5px] text-ink disabled:opacity-45"
                >
                  <AiAvatar mono={look.mono} glow={look.glow} size={26} />
                  {look.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {mode === 'write' && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) edit({ op: 'retask', item: plan.item.id, task: draft.trim() });
          }}
        >
          <textarea
            aria-label="这一项的要求"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full resize-y rounded-bubble border-0 bg-well px-3 py-2 text-[13px] leading-normal text-ink outline-none [font:inherit]"
          />
          <span className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="h-9 cursor-pointer rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:opacity-45"
            >
              保存
            </button>
            <button type="button" onClick={() => setMode(undefined)} className={QUIET}>
              不改了
            </button>
          </span>
        </form>
      )}
    </div>
  );
}

/** 展开的那个任务：用时、花费、停下或让它继续，是分工单里的一项还能改它；下面是过程 */
function TaskProcess({ task }: { task: RoomTask }) {
  const room = useRoom();
  const { group, me, owner, models, busy, act } = room;
  const look = aiLook(models, task.key);
  const now = useNow(task.live);
  const ai = group.ais.find((item) => item.key === task.key);
  const canStop = ai !== undefined && ai.runId === task.runId && (owner || ai.callers.includes(me));
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : undefined;
  const { plan } = task;
  const editable =
    plan?.open &&
    (plan.item.status === 'waiting' || plan.item.status === 'running') &&
    (owner || plan.callers.includes(me));
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
            className={QUIET}
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
      {plan && editable && <PlanActions key={`${plan.messageId}:${plan.item.id}`} plan={plan} />}
      {task.parts.length > 0 || task.todos?.length ? (
        <ProcessBody parts={task.parts} todos={task.todos} live={task.live} />
      ) : (
        <p className="m-0 text-[13px] text-ink-muted">{task.note}。还没有可以看的步骤。</p>
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
