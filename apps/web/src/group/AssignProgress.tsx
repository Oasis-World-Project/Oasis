// 分工单在聊天里的样子：一个 AI 把一件事的几部分交给了群里别的 AI。交了几项、一共几项，每项一个圆环
// （里面是负责它的 AI），「看分工」去工作台的任务。照原型 ② 的「任务进度」。
import type { AssignCard } from '@oasis/contracts/conversation';
import { AiAvatar } from '../ui/Avatar.tsx';
import { aiLook } from './people.ts';
import { useRoom } from './room.ts';
import { itemNote } from './workbench/tasks.ts';

/** 圆环的周长（半径 21） */
const RING = 2 * Math.PI * 21;
/** 分工单里一项做到哪了，画成圆环上的一段：交了是满的，在做是一半 */
const PROGRESS: Record<AssignCard['items'][number]['status'], number> = {
  waiting: 0,
  running: 0.5,
  done: 1,
  declined: 0,
  failed: 0,
  stopped: 0,
  dropped: 0,
};

export function AssignProgress({
  card,
  authorId,
  name,
}: {
  card: AssignCard;
  authorId: string;
  name: string;
}) {
  const { models, bench } = useRoom();
  const done = card.items.filter((item) => item.status === 'done').length;
  return (
    <section
      aria-label="任务进度"
      className="flex flex-wrap items-center gap-[18px] rounded-pop bg-glass-strong px-[18px] py-4 shadow-edge-strong"
    >
      <div className="flex items-baseline gap-2.5">
        <span className="font-display text-[30px] leading-none tracking-[-0.03em]">
          {done}/{card.items.filter((item) => item.status !== 'dropped').length}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[13.5px] font-medium">{card.title}</span>
          <span className="text-xs text-ink-muted">
            {aiLook(models, authorId, name).name} 分了工
          </span>
        </span>
      </div>
      <ul aria-label="分工" className="m-0 flex flex-1 list-none flex-wrap gap-2.5 p-0">
        {card.items.map((item) => {
          const look = aiLook(models, item.key);
          return (
            <li
              key={item.id}
              role="img"
              aria-label={`${look.name}：${item.task}，${itemNote(item)}`}
              title={`${look.name}：${item.task}（${itemNote(item)}）`}
              className="relative inline-flex size-[46px] items-center justify-center"
            >
              <svg
                width="46"
                height="46"
                viewBox="0 0 46 46"
                aria-hidden="true"
                className="absolute left-0 top-0"
              >
                <circle
                  cx="23"
                  cy="23"
                  r="21"
                  fill="none"
                  strokeWidth="2.5"
                  className="stroke-track"
                />
                {PROGRESS[item.status] > 0 && (
                  <circle
                    cx="23"
                    cy="23"
                    r="21"
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeDasharray={`${(RING * PROGRESS[item.status]).toFixed(1)} ${RING.toFixed(1)}`}
                    transform="rotate(-90 23 23)"
                    className="stroke-accent"
                  />
                )}
              </svg>
              <AiAvatar mono={look.mono} glow={look.glow} size={30} />
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => bench.openTasks()}
        className="h-[38px] cursor-pointer rounded-full border-0 bg-solid px-4 text-[13px] font-medium text-on-solid"
      >
        看分工
      </button>
    </section>
  );
}
