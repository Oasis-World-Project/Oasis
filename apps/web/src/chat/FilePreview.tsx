// 成果预览窗：图片、视频、音频、PDF、文字类和静态网页直接看；其他格式提示下载后打开。
// 网页放在不带 allow-same-origin 的 iframe 里，服务端还加了 CSP sandbox，AI 写的脚本碰不到登录状态。
import { Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../ui/format.ts';
import { baseName, previewKindOf } from './files.ts';
import { Markdown } from './Markdown.tsx';

export interface PreviewFile {
  path: string;
  size: number;
  url: string;
  downloadUrl: string;
}

/** 文字类文件最多显示这么多，再多请下载 */
const TEXT_LIMIT = 200_000;

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setText(await response.text());
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) setFailed(true);
      });
    return () => controller.abort();
  }, [url]);
  if (failed) return <p className="m-0 p-6 text-sm text-accent">文件没能打开，请下载后查看。</p>;
  if (text === null) return <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>;
  const cut = text.length > TEXT_LIMIT;
  const shown = cut ? text.slice(0, TEXT_LIMIT) : text;
  const more = cut && (
    <p className="m-0 mt-4 text-ink-muted">（只显示了前一部分，完整内容请下载）</p>
  );
  if (markdown) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-7">
        <Markdown source={shown} />
        {more}
      </div>
    );
  }
  return (
    <pre className="m-0 whitespace-pre-wrap break-words px-7 py-6 font-sans text-[14px] leading-relaxed text-ink">
      {cut ? text.slice(0, TEXT_LIMIT) : text}
      {cut && (
        <span className="mt-4 block text-ink-muted">（只显示了前一部分，完整内容请下载）</span>
      )}
    </pre>
  );
}

function Body({ file }: { file: PreviewFile }) {
  const name = baseName(file.path);
  switch (previewKindOf(file.path)) {
    case 'image':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <img
            src={file.url}
            alt={name}
            className="max-h-full max-w-full rounded-item object-contain"
          />
        </div>
      );
    case 'video':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <video src={file.url} controls className="max-h-full max-w-full rounded-item" />
        </div>
      );
    case 'audio':
      return (
        <div className="flex h-full items-center justify-center p-10">
          <audio src={file.url} controls className="w-full max-w-xl" />
        </div>
      );
    case 'pdf':
      return <iframe title={name} src={file.url} className="size-full border-0" />;
    case 'page':
      return (
        <iframe
          title={name}
          src={file.url}
          sandbox=""
          className="size-full border-0 bg-glass-active"
        />
      );
    case 'text':
      return <TextPreview url={file.url} markdown={file.path.toLowerCase().endsWith('.md')} />;
    default:
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
          <p className="m-0 text-[15px]">这种文件暂时不能在这里预览</p>
          <p className="m-0 text-sm text-ink-muted">下载后用电脑上的软件打开。</p>
        </div>
      );
  }
}

export function FilePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
  }, []);
  const name = baseName(file.path);
  return (
    <dialog
      ref={dialog}
      aria-label={`预览 ${name}`}
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        // 点到窗外（落在 dialog 自己身上）就关掉
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto h-[min(86vh,900px)] w-[min(92vw,1100px)] max-w-none overflow-hidden rounded-panel border-0 bg-transparent p-0 text-ink backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <div className="flex size-full flex-col rounded-panel bg-glass-active shadow-panel backdrop-blur-2xl">
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="m-0 truncate text-[15px] font-medium">{name}</h2>
            <span className="text-xs text-ink-muted">{formatBytes(file.size)}</span>
          </div>
          <a
            href={file.downloadUrl}
            download={name}
            className="flex h-10 items-center gap-1.5 rounded-full bg-solid px-4 text-[13px] font-medium text-on-solid no-underline"
          >
            <Download size={15} aria-hidden="true" />
            下载
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="flex size-10 items-center justify-center rounded-full border-0 bg-glass-active text-ink"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <Body file={file} />
        </div>
      </div>
    </dialog>
  );
}
