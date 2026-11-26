// 输入框上的两样：「＋」弹出的菜单（作为任务发布、上传文件、引用工作台里的文件）和上面那行「几个 AI 在忙」。
import { MAX_FILE_REFS } from '@oasis/contracts/group';
import { useState } from 'react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { aiLook } from './people.ts';
import { Popover } from './RoomHeader.tsx';
import { useRoom } from './room.ts';
import { fileNote, useClock } from './workbench/files.tsx';

export const ROUND =
  'flex size-10 cursor-pointer items-center justify-center rounded-full border-0 text-ink shadow-[inset_0_0_0_1px_var(--oasis-track)] disabled:cursor-not-allowed disabled:opacity-45';
const MENU_ITEM =
  'h-11 cursor-pointer rounded-[20px] border-0 bg-transparent px-3 text-left text-sm font-medium text-ink hover:bg-glass-active disabled:cursor-not-allowed disabled:opacity-45';

/** 「＋」弹出的菜单：上传文件、引用工作台里的文件（再点开是群文件的单子） */
export function PlusMenu({
  anchor,
  refs,
  task,
  onTask,
  onUpload,
  onRef,
  onClose,
}: {
  anchor: string;
  refs: string[];
  /** 这句话是不是作为任务发布 */
  task: boolean;
  onTask: (next: boolean) => void;
  onUpload: () => void;
  onRef: (path: string) => void;
  onClose: () => void;
}) {
  const room = useRoom();
  const [listing, setListing] = useState(false);
  const now = useClock();
  const files = room.bench.files.filter((file) => !refs.includes(file.path));
  return (
    <Popover
      label="更多"
      role="menu"
      onClose={onClose}
      className={`${anchor} left-[18px] w-[280px] gap-0.5 rounded-pop p-2`}
    >
      {listing ? (
        <>
          <span className="px-3 pb-1 pt-2 text-[12.5px] text-ink-muted">引用哪个文件</span>
          <div className="scroll-quiet flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
            {files.map((file) => (
              <button
                key={file.id}
                type="button"
                role="menuitem"
                onClick={() => onRef(file.path)}
                className="flex cursor-pointer flex-col gap-px rounded-[20px] border-0 bg-transparent px-3 py-2 text-left text-ink hover:bg-glass-active"
              >
                <span className="truncate text-sm font-medium">{file.name}</span>
                <span className="truncate text-xs text-ink-muted">{fileNote(room, file, now)}</span>
              </button>
            ))}
            {files.length === 0 && (
              <span className="px-3 py-2 text-[13px] text-ink-muted">没有别的群文件了。</span>
            )}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={task}
            onClick={() => onTask(!task)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[20px] border-0 bg-transparent px-3 py-2.5 text-left text-ink hover:bg-glass-active"
          >
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">作为任务发布</span>
              <span className="text-xs text-ink-muted">
                没 @ 谁时挑最对口的 AI 出来负责，它可以把一部分交给别的 AI
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-[22px] w-[38px] shrink-0 rounded-full ${task ? 'bg-accent' : 'bg-dot-idle'}`}
            >
              <span
                className={`absolute top-[3px] size-4 rounded-full bg-on-solid shadow-raised ${task ? 'left-[19px]' : 'left-[3px]'}`}
              />
            </span>
          </button>
          <button type="button" role="menuitem" onClick={onUpload} className={MENU_ITEM}>
            上传文件
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!room.bench.files.length || refs.length >= MAX_FILE_REFS}
            title={room.bench.files.length ? undefined : '还没有群文件'}
            onClick={() => setListing(true)}
            className={MENU_ITEM}
          >
            引用工作台里的文件
          </button>
        </>
      )}
    </Popover>
  );
}

/** 输入框上面那行：几个 AI 在忙，谁在旁听；点它去工作台看它们在做什么 */
export function BusyLine() {
  const { group, models, bench } = useRoom();
  const busy = group.ais.filter((ai) => ai.runId);
  const idle = group.ais.filter((ai) => !ai.runId);
  if (!busy.length) return null;
  const names = idle.map((ai) => aiLook(models, ai.key).name);
  return (
    <button
      type="button"
      onClick={() => bench.openTasks()}
      className="mx-auto mb-2.5 flex h-[30px] cursor-pointer items-center gap-2 rounded-full border-0 bg-transparent py-0 pl-1.5 pr-3 text-[12.5px] text-ink-muted"
    >
      <span
        aria-hidden="true"
        className="relative h-5 shrink-0"
        style={{ width: (busy.length - 1) * 14 + 20 }}
      >
        {busy.map((ai, index) => {
          const look = aiLook(models, ai.key);
          return (
            <span key={ai.key} className="absolute top-0" style={{ left: index * 14 }}>
              <AiAvatar mono={look.mono} glow={look.glow} size={20} />
            </span>
          );
        })}
      </span>
      {busy.length} 个 AI 在工作台忙{names.length ? `，${names.join('、')} 在旁听` : ''}
    </button>
  );
}
