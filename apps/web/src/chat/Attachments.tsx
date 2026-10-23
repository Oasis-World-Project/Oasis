// 附件：输入框上方待发送的文件条（带上传进度，可移除），以及用户消息下面已发出的附件。
import type { MessageAttachment } from '@oasis/contracts/conversation';
import { X } from 'lucide-react';
import { useState } from 'react';
import { uploadUrl } from '../api/upload.ts';
import { formatBytes } from '../ui/format.ts';
import { FileChip } from './FileChip.tsx';
import { FilePreview, type PreviewFile } from './FilePreview.tsx';
import type { PendingFile } from './use-attachments.ts';

export function PendingFiles({
  files,
  onRemove,
}: {
  files: PendingFile[];
  onRemove: (key: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="要发送的文件" className="m-0 flex list-none flex-wrap gap-1.5 p-0 pb-1">
      {files.map((file) => (
        <li
          key={file.key}
          className="relative flex h-9 max-w-[240px] items-center gap-2 overflow-hidden rounded-full bg-glass-strong pl-3 pr-1 shadow-edge-strong"
        >
          {file.status === 'uploading' && (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 bg-track transition-[width]"
              style={{ width: `${Math.round(file.progress * 100)}%` }}
            />
          )}
          <span className="relative flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[12.5px] font-medium">{file.name}</span>
            <span
              className={`text-[10.5px] ${file.status === 'failed' ? 'text-accent' : 'text-ink-muted'}`}
            >
              {file.status === 'uploading'
                ? file.progress >= 1
                  ? '正在保存…'
                  : `上传中 ${Math.round(file.progress * 100)}%`
                : file.status === 'failed'
                  ? (file.error ?? '上传失败')
                  : formatBytes(file.size)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(file.key)}
            aria-label={`移除 ${file.name}`}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-glass-active hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 用户消息下面的附件：点开预览，单独下载 */
export function SentAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const toPreview = (a: MessageAttachment): PreviewFile => ({
    path: a.name,
    size: a.size,
    url: uploadUrl(a.id),
    downloadUrl: uploadUrl(a.id, true),
  });
  return (
    <>
      <ul
        aria-label="附件"
        className="m-0 -mt-2 ml-auto flex w-full max-w-[320px] list-none flex-col gap-1.5 p-0"
      >
        {attachments.map((a) => (
          <FileChip key={a.id} file={toPreview(a)} onOpen={() => setPreview(toPreview(a))} />
        ))}
      </ul>
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
