// 工作台：聊天窗右边的窗口。收起时是一条（任务做完了几个、谁在忙）；展开后三个页签：
// 预览（打开的群文件）、文件（群文件）、任务（每个 AI 的任务，过程在这里看），还能拉宽。照原型 ②⑥。
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { AiAvatar } from '../../ui/Avatar.tsx';
import { aiLook } from '../people.ts';
import { useRoom } from '../room.ts';
import { FilesTab } from './FilesTab.tsx';
import { PreviewTab } from './PreviewTab.tsx';
import { TasksTab } from './TasksTab.tsx';
import type { BenchTab, Workbench as State } from './use-workbench.ts';

const WINDOW = 'glass-window box-border flex min-w-0 flex-col rounded-window';
const ROUND =
  'flex size-10 cursor-pointer items-center justify-center rounded-full border-0 bg-glass-strong text-ink shadow-edge-strong';
const TABS: { id: BenchTab; label: string }[] = [
  { id: 'preview', label: '预览' },
  { id: 'files', label: '文件' },
  { id: 'tasks', label: '任务' },
];
/** 收起时那个圆环的周长（半径 28） */
const RING = 2 * Math.PI * 28;

/** 收起的工作台：展开按钮、任务做完了几个、在忙的 AI */
function Rail({ bench }: { bench: State }) {
  const { group, models } = useRoom();
  const busy = group.ais.filter((ai) => ai.runId);
  const done = bench.tasks.filter((task) => task.column === 'done').length;
  const total = bench.tasks.length;
  return (
    <section
      aria-label="工作台（收起）"
      className={`${WINDOW} w-[104px] shrink-0 items-center gap-[18px] py-[22px]`}
    >
      <button
        type="button"
        aria-label="展开工作台"
        onClick={() => bench.setMode('open')}
        className="flex size-11 cursor-pointer items-center justify-center rounded-full border-0 bg-bubble text-ink shadow-edge-bright"
      >
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <span className="text-[12.5px] font-medium tracking-[0.3em] [writing-mode:vertical-rl]">
        工作台
      </span>
      {total > 0 && (
        <span
          role="img"
          aria-label={`任务完成 ${done}/${total}`}
          className="relative flex size-16 items-center justify-center"
        >
          <svg
            width="64"
            height="64"
            viewBox="0 0 64 64"
            aria-hidden="true"
            className="absolute left-0 top-0"
          >
            <circle cx="32" cy="32" r="28" fill="none" strokeWidth="3" className="stroke-track" />
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${((RING * done) / total).toFixed(1)} ${RING.toFixed(1)}`}
              transform="rotate(-90 32 32)"
              className="stroke-accent"
            />
          </svg>
          <span className="font-display text-[15px]">
            {done}/{total}
          </span>
        </span>
      )}
      <span className="flex-1" />
      {busy.map((ai) => {
        const look = aiLook(models, ai.key);
        return <AiAvatar key={ai.key} mono={look.mono} glow={look.glow} size={40} glowing />;
      })}
      {busy.length > 0 && (
        <span className="text-center text-[11.5px] leading-[1.4] text-ink-muted">
          {busy.length} 个 AI
          <br />
          在忙
        </span>
      )}
    </section>
  );
}

export function Workbench({ bench }: { bench: State }) {
  if (bench.mode === 'collapsed') return <Rail bench={bench} />;
  const wide = bench.mode === 'wide';
  return (
    <section
      aria-label="工作台"
      className={`${WINDOW} gap-3.5 p-4 ${wide ? 'flex-[3_1_640px]' : 'flex-[1_1_400px]'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="工作台视图"
          className="flex gap-0.5 rounded-full bg-well p-1"
        >
          {TABS.map((tab) => {
            const on = bench.tab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => bench.setTab(tab.id)}
                className={`h-9 cursor-pointer rounded-full border-0 px-4 text-[13.5px] text-ink ${
                  on ? 'bg-on-solid font-medium shadow-raised' : 'bg-transparent'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={wide ? '恢复工作台宽度' : '拉宽工作台'}
          onClick={() => bench.setMode(wide ? 'open' : 'wide')}
          className={ROUND}
        >
          {wide ? (
            <Minimize2 size={17} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <Maximize2 size={17} strokeWidth={1.9} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label="收起工作台"
          onClick={() => bench.setMode('collapsed')}
          className={ROUND}
        >
          <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {bench.tab === 'preview' ? (
        <PreviewTab bench={bench} />
      ) : bench.tab === 'files' ? (
        <FilesTab bench={bench} />
      ) : (
        <TasksTab bench={bench} />
      )}
    </section>
  );
}
