// 工作台的「预览」页签：上面一排是打开着的文件，下面看正在看的那个——文件名、谁做的谁改过，
// 「发到群里」（引用进输入框）、下载、删除；AI 交的文件群主可以「在画布里打开」（批注、让 AI 改）。预览只看不改。照原型 ②。
import { Link } from '@tanstack/react-router';
import { Download, X } from 'lucide-react';
import { deleteGroupFile } from '../../api/queries.ts';
import { PreviewBody } from '../../chat/FilePreview.tsx';
import { ConfirmButton } from '../../chat/parts.tsx';
import { formatBytes } from '../../ui/format.ts';
import { aiLook } from '../people.ts';
import { useRoom } from '../room.ts';
import { fileNote, previewOf, useClock } from './files.tsx';
import type { Workbench } from './use-workbench.ts';

export function PreviewTab({ bench }: { bench: Workbench }) {
  const room = useRoom();
  const { group, me, owner, models, busy, act } = room;
  const file = bench.current;
  const now = useClock();
  if (!file)
    return (
      <p className="m-0 flex flex-1 items-center justify-center px-6 text-center text-[13px] leading-relaxed text-ink-muted">
        点聊天里、任务里的文件，在这里预览。
      </p>
    );
  // 传这个文件的人和群主可以删，AI 交的只有群主可以
  const canDelete = owner || (file.madeBy.kind === 'user' && file.madeBy.id === me);
  const preview = previewOf(group, file, bench.files);
  return (
    <>
      <div
        role="tablist"
        aria-label="打开的文件"
        className="scroll-quiet flex gap-1.5 overflow-x-auto"
      >
        {bench.opened.map((path) => {
          const item = bench.files.find((f) => f.path === path);
          if (!item) return null;
          const on = item.id === file.id;
          // 文件名前的光点：现在这一版是哪个 AI 交的就是它的光色
          const glow =
            item.changedBy.kind === 'ai'
              ? aiLook(models, item.changedBy.id).glow
              : 'var(--oasis-hairline)';
          return (
            <span
              key={path}
              className={`flex h-9 shrink-0 items-center rounded-full pl-2 pr-1 text-[13px] text-ink ${
                on ? 'bg-glass-active font-medium shadow-raised' : 'bg-glass shadow-edge'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => bench.openFile(path)}
                className="flex h-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 pr-1.5 text-ink [font:inherit]"
              >
                <span
                  aria-hidden="true"
                  className="size-5 rounded-full bg-on-solid"
                  style={{ boxShadow: `0 0 0 1.5px ${glow}, 0 0 10px ${glow}` }}
                />
                {item.name}
              </button>
              <button
                type="button"
                aria-label={`关掉 ${item.name} 的预览`}
                onClick={() => bench.closeFile(path)}
                className="flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      <article
        aria-label={`预览 ${file.name}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-pop bg-bubble shadow-edge-bright"
      >
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-[30px] pb-3 pt-7">
          <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
            <h2 className="m-0 break-words text-[26px] font-light leading-[1.25] tracking-[0.01em]">
              {file.name}
            </h2>
            <p className="m-0 text-[13px] text-ink-muted">
              {fileNote(room, file, now)} · {formatBytes(file.size)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {group.kind === 'group' && (
              <button
                type="button"
                onClick={() => room.bench.quote(file.path)}
                className="h-9 cursor-pointer rounded-full border-0 bg-solid px-3.5 text-[12.5px] font-medium text-on-solid"
              >
                发到群里
              </button>
            )}
            {file.artifactId && (
              <Link
                to="/canvas/artifacts/$artifactId"
                params={{ artifactId: file.artifactId }}
                className="flex h-9 items-center rounded-full bg-glass-active px-3.5 text-[12.5px] text-ink no-underline shadow-edge-strong"
              >
                在画布里打开
              </Link>
            )}
            <a
              href={preview.downloadUrl}
              download={file.name}
              aria-label={`下载 ${file.name}`}
              className="flex size-9 items-center justify-center rounded-full bg-glass-active text-ink no-underline shadow-edge-strong"
            >
              <Download size={15} aria-hidden="true" />
            </a>
            {group.kind === 'group' && canDelete && (
              <ConfirmButton
                label="删除"
                question="从群文件里删掉？"
                confirmLabel="删掉"
                disabled={busy}
                onConfirm={() => void act(() => deleteGroupFile(group.id, file.id))}
              />
            )}
          </div>
        </header>
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
          <PreviewBody key={preview.url} file={preview} />
        </div>
      </article>
    </>
  );
}
