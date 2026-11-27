// 点开一个任务弹出的窗：谁负责、用时、花费，成果在上、过程在下；能停下、让它继续；它在等你点确认卡时就在这里点；
// 是分工单里还没结束的一项还能改派、改要求、撤掉。照原型 ㉕ ㉚。
import type { AssignEditBody } from '@oasis/contracts/group';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmTurn, editAssign, stopRun } from '../../api/queries.ts';
import { ConfirmationCards } from '../../chat/ConfirmationCards.tsx';
import { ProcessBody } from '../../chat/Process.tsx';
import { elapsedText, useNow } from '../../chat/task-status.ts';
import { AiAvatar } from '../../ui/Avatar.tsx';
import { formatCost } from '../../ui/format.ts';
import { actionsFor } from '../ai-actions.ts';
import { aiLook, runsOf } from '../people.ts';
import { dmAct, useRoom } from '../room.ts';
import type { RoomTask } from './tasks.ts';

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

/** 点开的那个任务：谁负责、用时、花费，停下或让它继续，是分工单里的一项还能改它；成果在上，过程在下 */
export function TaskDialog({
  task,
  onClose,
  onFile,
}: {
  task: RoomTask;
  onClose: () => void;
  onFile: (path: string) => void;
}) {
  const room = useRoom();
  const { group, me, owner, models, busy } = room;
  const actions = actionsFor(room, task.key);
  const look = aiLook(models, task.key);
  const now = useNow(task.live);
  const ai = group.ais.find((item) => item.key === task.key);
  // 这个任务正在做的那一轮：它自己那份会话的，或云端任务的。群主和引来它的人能停
  const run = ai && runsOf(ai).find((item) => item.runId === task.runId);
  const canStop = run !== undefined && (owner || run.callers.includes(me));
  const stop = () =>
    group.kind === 'dm'
      ? dmAct(room, () => stopRun(group.id, task.runId))
      : room.act(() => stopRun(group.id, task.runId));
  const ended = task.finishedAt ? Date.parse(task.finishedAt) : undefined;
  const { plan } = task;
  const editable =
    plan?.open &&
    (plan.item.status === 'waiting' || plan.item.status === 'running') &&
    (owner || plan.callers.includes(me));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const facts = [
    `${look.name} 负责`,
    task.live || ended !== undefined
      ? `用时 ${elapsedText((ended ?? now) - Date.parse(task.startedAt))}`
      : '',
    task.spentMicro > 0 ? formatCost(task.spentMicro) : '还没花钱',
  ].filter(Boolean);
  // 放到页面最外层：工作台这块是毛玻璃，fixed 的东西在它里面会被框住
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-veil p-6 backdrop-blur-sm"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        className="box-border flex max-h-full w-[760px] max-w-full flex-col gap-[18px] rounded-dialog bg-glass-active p-6 shadow-dialog"
      >
        <header className="flex items-start gap-3.5">
          <AiAvatar mono={look.mono} glow={look.glow} size={48} glowing={task.live} />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 break-words text-[28px] font-light leading-[1.2]">{task.title}</h2>
            <p className="m-0 mt-1.5 text-[13px] text-ink-muted">{facts.join(' · ')}</p>
          </div>
          {canStop && (
            <button type="button" disabled={busy} onClick={() => void stop()} className={QUIET}>
              停下
            </button>
          )}
          {task.resumable && !run && (
            <button
              type="button"
              disabled={busy || room.sending}
              onClick={() =>
                void (task.seat
                  ? room.send('继续', group.kind === 'dm' ? [] : [{ kind: 'ai', key: task.key }], {
                      seat: task.seat,
                    })
                  : actions.say('continue', '继续'))
              }
              className="h-9 cursor-pointer rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:opacity-45"
            >
              让它继续
            </button>
          )}
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-9 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-well text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {task.live &&
        group.confirmations.length > 0 &&
        (group.kind === 'dm' || ai?.runId === task.runId) ? (
          // 我叫的这一轮在等我点的确认卡：就在这个进行中的任务里点
          <ConfirmationCards
            decide={(id, decision) => confirmTurn(group, id, decision)}
            cards={group.confirmations}
            messages={group.messages}
            onDecided={() => void room.refresh()}
          />
        ) : (
          task.asking && (
            <p className="m-0 rounded-bubble bg-accent-tint px-4 py-3 text-[13.5px] text-accent-ink">
              <span className="font-medium">在等人：</span>
              {task.note}。到聊天里回它。
            </p>
          )
        )}
        <div className="scroll-quiet flex min-h-0 flex-col gap-[18px] overflow-y-auto">
          {task.files.length > 0 && (
            <section aria-label="成果" className="flex flex-col gap-2.5">
              <h3 className="m-0 text-sm font-medium">成果</h3>
              <span className="flex flex-wrap gap-1.5">
                {task.files.map((file) => (
                  <button
                    key={file.artifactId}
                    type="button"
                    onClick={() => {
                      onFile(file.path);
                      onClose();
                    }}
                    className="h-[30px] max-w-full cursor-pointer truncate rounded-full border-0 bg-well px-3 text-xs font-medium text-ink"
                  >
                    {file.name}
                  </button>
                ))}
              </span>
            </section>
          )}
          {plan && editable && (
            <PlanActions key={`${plan.messageId}:${plan.item.id}`} plan={plan} />
          )}
          <section aria-label="过程" className="flex flex-col gap-2.5">
            <h3 className="m-0 text-sm font-medium">过程</h3>
            {task.parts.length > 0 || task.todos?.length ? (
              <ProcessBody parts={task.parts} todos={task.todos} live={task.live} />
            ) : (
              <p className="m-0 text-[13px] text-ink-muted">{task.note}。还没有可以看的步骤。</p>
            )}
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
}
