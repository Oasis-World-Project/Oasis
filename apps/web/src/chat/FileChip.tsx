// 一个文件：格式标记、文件名、大小；点开预览，右边单独下载。交付的成果和用户发的附件都用它。
import { Download } from 'lucide-react';
import { formatBytes } from '../ui/format.ts';
import { badgeOf, baseName } from './files.ts';
import type { PreviewFile } from './FilePreview.tsx';

export function FileChip({ file, onOpen }: { file: PreviewFile; onOpen: () => void }) {
  const name = baseName(file.path);
  return (
    <li className="flex min-w-0 items-center gap-1 rounded-full bg-glass-active pr-1 shadow-edge-strong">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`预览 ${name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full border-0 bg-transparent py-1.5 pl-1.5 pr-2 text-left text-ink"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-solid font-display text-[8.5px] font-medium text-on-solid"
        >
          {badgeOf(file.path)}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium">{name}</span>
          <span className="text-[11.5px] text-ink-muted">{formatBytes(file.size)}</span>
        </span>
      </button>
      <a
        href={file.downloadUrl}
        download={name}
        aria-label={`下载 ${name}`}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-muted no-underline hover:bg-glass-strong hover:text-ink"
      >
        <Download size={16} aria-hidden="true" />
      </a>
    </li>
  );
}
