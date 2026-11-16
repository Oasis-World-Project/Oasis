// 工作台的「文件」页签：群文件一格一个——格式、是谁的（正在改时头像发光）、文件名、谁做的谁改过。
// 点开在「预览」里看。照原型 ②。
import { badgeOf } from '../../chat/files.ts';
import { formatBytes } from '../../ui/format.ts';
import { useRoom } from '../room.ts';
import { AuthorAvatar, beingChanged, fileNote, useClock } from './files.tsx';
import type { Workbench } from './use-workbench.ts';

export function FilesTab({ bench }: { bench: Workbench }) {
  const room = useRoom();
  const now = useClock();
  if (!bench.files.length)
    return (
      <p className="m-0 flex flex-1 items-center justify-center px-6 text-center text-[13px] leading-relaxed text-ink-muted">
        还没有群文件。
        <br />
        AI 交的文件、大家用输入框的「＋」传的文件都在这里。
      </p>
    );
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-0.5 py-1">
      <ul
        aria-label="群文件"
        className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 p-0"
      >
        {bench.files.map((file) => {
          const note = fileNote(room, file, now);
          return (
            <li key={file.id}>
              <button
                type="button"
                aria-label={`${file.path}，${note}，${formatBytes(file.size)}`}
                title={`${file.path} · ${formatBytes(file.size)}`}
                onClick={() => bench.openFile(file.path)}
                className="relative box-border flex h-[148px] w-full cursor-pointer flex-col justify-between rounded-card border-0 bg-bubble p-4 text-left text-ink shadow-edge-bright"
              >
                <span className="flex items-start justify-between">
                  <span className="font-display text-[18px] leading-none tracking-[-0.02em] text-ink-muted">
                    {badgeOf(file.path)}
                  </span>
                  <AuthorAvatar
                    author={file.changedBy}
                    size={34}
                    glowing={beingChanged(room, file)}
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{file.name}</span>
                  <span className="truncate text-xs text-ink-muted">{note}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
