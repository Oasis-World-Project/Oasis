// 很长的话（比如粘贴的大段材料、要改的地方）在聊天里只显示开头，全文在对话框里。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CardButton } from './parts.tsx';

function MessageDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto max-h-[80vh] w-[min(90vw,640px)] max-w-none overflow-y-auto rounded-panel border-0 bg-glass-active p-6 text-ink shadow-panel backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <header className="mb-4 flex items-center justify-between gap-4">
        <h2 className="m-0 text-base font-medium">{title}</h2>
        <CardButton onClick={onClose}>关闭</CardButton>
      </header>
      {children}
    </dialog>
  );
}

export function MessageText({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const long = content.length > 360 || content.split('\n').length > 8;
  if (!long) return <>{content}</>;
  return (
    <>
      <p className="m-0 line-clamp-4">{content.slice(0, 240)}…</p>
      <button
        type="button"
        className="mt-2 rounded-item border-0 bg-glass-strong px-3 py-1 text-xs text-ink"
        onClick={() => setOpen(true)}
      >
        查看全文 · {content.length} 字
      </button>
      {open && (
        <MessageDialog title="消息全文" onClose={() => setOpen(false)}>
          <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">{content}</p>
          <CardButton onClick={() => void navigator.clipboard.writeText(content)}>
            复制全文
          </CardButton>
        </MessageDialog>
      )}
    </>
  );
}
