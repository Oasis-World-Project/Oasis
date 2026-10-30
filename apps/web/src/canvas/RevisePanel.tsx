// 「发给 AI 修改」（ADR 0012）：写下修改意见、可附文件、选发给哪个 AI（默认做出这一版的那个），
// 发出后在那个 AI 的私聊里出现修改意见和新的任务卡；新版交付后整体替换这一版。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import {
  createDm,
  dmsQuery,
  messagesQuery,
  modelsQuery,
  reviseTask,
  tasksQuery,
} from '../api/queries.ts';
import { PendingFiles } from '../chat/Attachments.tsx';
import { useAttachments } from '../chat/use-attachments.ts';

const field =
  'w-full rounded-item border-0 bg-glass-active px-3.5 py-2.5 text-[14px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';

export function RevisePanel({
  taskId,
  taskTitle,
  conversationId,
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  /** 做出这一版的私聊（默认发给它）；没有时用第一个能聊的 AI */
  conversationId: string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
  }, []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: models = [] } = useQuery(modelsQuery);
  const { data: dms = [] } = useQuery(dmsQuery);
  const chattable = models.filter((m) => m.category === 'llm' && m.available);
  const original = dms.find((d) => d.id === conversationId)?.modelKey ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const modelKey = picked ?? original ?? chattable[0]?.key ?? '';
  const [request, setRequest] = useState('');
  const files = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: async () => {
      const target =
        modelKey === original && conversationId
          ? conversationId
          : (dms.find((d) => d.modelKey === modelKey)?.id ?? (await createDm(modelKey)).id);
      await reviseTask(target, { taskId, request: request.trim(), attachments: files.ids });
      return target;
    },
    onSuccess: async (target) => {
      files.clear();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: messagesQuery(target).queryKey }),
      ]);
      onClose();
      await navigate({ to: '/dms/$conversationId', params: { conversationId: target } });
    },
  });

  const ready = request.trim().length > 0 && !!modelKey && !files.uploading && !files.failed;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready && !send.isPending) send.mutate();
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`修改「${taskTitle}」`}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto max-h-[88vh] w-[min(92vw,560px)] max-w-none overflow-hidden rounded-panel border-0 bg-transparent p-0 text-ink backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="flex max-h-[88vh] flex-col rounded-panel bg-glass-active shadow-panel backdrop-blur-2xl"
      >
        <header className="flex items-center gap-3 border-b border-hairline px-6 py-4">
          <h2 className="m-0 min-w-0 flex-1 truncate text-[17px] font-medium">
            修改「{taskTitle}」
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex size-9 items-center justify-center rounded-full border-0 bg-track text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">要怎么改</span>
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={5}
              maxLength={8000}
              required
              className={`${field} resize-y`}
              placeholder="比如：标题改成「山居」，第二段再短一点，配图换成夜景"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <PendingFiles files={files.files} onRemove={files.remove} />
            {files.notice && <p className="m-0 text-[12.5px] text-accent">{files.notice}</p>}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) files.add(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="inline-flex h-9 items-center gap-1.5 self-start rounded-full border-0 bg-glass-strong px-3.5 text-[13px] text-ink shadow-edge-strong"
            >
              <Paperclip size={14} aria-hidden="true" />
              附上参考文件
            </button>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">发给谁</span>
            <select value={modelKey} onChange={(e) => setPicked(e.target.value)} className={field}>
              {chattable.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                  {m.key === original ? '（做出这一版的）' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
            AI
            团队会在这一版的基础上做出新版，只改你提到的地方。新版交付后会替换这一版，旧版本不保留；没做成时这一版不受影响。
          </p>
          {send.isError && (
            <p role="alert" className="m-0 text-[13px] text-accent">
              {send.error instanceof ApiError ? send.error.message : '没发出去，请重试'}
            </p>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-hairline px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-full border-0 bg-transparent px-4 text-[13.5px] text-ink-muted"
          >
            算了
          </button>
          <button
            type="submit"
            disabled={!ready || send.isPending}
            className="h-10 rounded-full border-0 bg-accent px-5 text-[13.5px] font-medium text-on-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            {send.isPending ? '正在发…' : files.uploading ? '文件还在上传…' : '发给 AI 修改'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
