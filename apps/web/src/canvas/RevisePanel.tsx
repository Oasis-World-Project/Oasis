// 「发给 AI 修改」（ADR 0012）：写下修改意见、可附文件、选发给哪个 AI（默认做出这一版的那个），
// 发出后在那个 AI 的私聊里出现修改意见和新的任务卡；新版交付后整体替换这一版。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MAX_ATTACHMENTS,
  type RevisionNote,
  type RevisionParameter,
} from '@oasis/contracts/conversation';
import { ApiError } from '../api/client.ts';
import {
  artifactsQuery,
  createDm,
  dmsQuery,
  messagesQuery,
  modelsQuery,
  reviseTask,
  tasksQuery,
} from '../api/queries.ts';
import { uploadFile } from '../api/upload.ts';
import { PendingFiles } from '../chat/Attachments.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { toRevisionNotes } from './annotations.ts';
import { buildSnapshots } from './snapshots.ts';

/** 标注截图最多带几张（和自己附的文件合计不超过一条消息的上限） */
const MAX_SNAPSHOTS = 8;

const field =
  'w-full rounded-item border-0 bg-glass-active px-3.5 py-2.5 text-[14px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';

export function RevisePanel({
  taskId,
  taskTitle,
  conversationId,
  parameters = [],
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  /** 做出这一版的私聊（默认发给它）；没有时用第一个能聊的 AI */
  conversationId: string | null;
  /** 从参数面板来的成品参数（ADR 0012 §12） */
  parameters?: RevisionParameter[];
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
  // 这个任务的成果上的批注（ADR 0012 §9）：默认一起带上
  const { data: artifacts = [] } = useQuery(artifactsQuery(taskId));
  const noted = artifacts.filter((a) => a.annotations.length > 0);
  const noteCount = noted.reduce((n, a) => n + a.annotations.length, 0);
  const [withNotes, setWithNotes] = useState(true);
  const [stage, setStage] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      const target =
        modelKey === original && conversationId
          ? conversationId
          : (dms.find((d) => d.modelKey === modelKey)?.id ?? (await createDm(modelKey)).id);
      let annotations: RevisionNote[] = [];
      const shots: string[] = [];
      if (withNotes && noteCount > 0) {
        setStage('正在合成标注截图…');
        const room = Math.min(MAX_SNAPSHOTS, MAX_ATTACHMENTS - files.ids.length);
        const built =
          room > 0
            ? await buildSnapshots(noted, artifacts, room)
            : { files: [], nameOf: () => undefined };
        setStage('正在上传标注截图…');
        for (const shot of built.files) shots.push((await uploadFile(shot, () => {})).id);
        annotations = toRevisionNotes(noted, built.nameOf);
      }
      setStage(null);
      await reviseTask(target, {
        taskId,
        request: request.trim(),
        annotations,
        parameters,
        attachments: [...files.ids, ...shots],
      });
      return target;
    },
    onSettled: () => setStage(null),
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

  const ready =
    (request.trim().length > 0 || (withNotes && noteCount > 0) || parameters.length > 0) &&
    !!modelKey &&
    !files.uploading &&
    !files.failed;
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
              className={`${field} resize-y`}
              placeholder="比如：标题改成「山居」，第二段再短一点，配图换成夜景"
            />
          </label>
          {parameters.length > 0 && (
            <section aria-label="参数修改" className="flex flex-col gap-1 text-[13.5px]">
              <span className="font-medium">参数修改（{parameters.length} 项）</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 rounded-item bg-glass-strong px-3 py-2 text-[13px]">
                {parameters.map((p) => (
                  <li key={`${p.file}-${p.name}`}>
                    {p.name}：<strong className="font-medium">{p.value}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {noteCount > 0 && (
            <label className="flex items-start gap-2 text-[13.5px]">
              <input
                type="checkbox"
                checked={withNotes}
                onChange={(e) => setWithNotes(e.target.checked)}
                className="mt-1 accent-accent"
              />
              <span>
                带上画布上的 {noteCount} 条批注
                <span className="block text-[12px] text-ink-muted">
                  每条批注写明在哪个文件、哪里；圈画过的画面会合成标注截图一起发过去
                </span>
              </span>
            </label>
          )}
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
            {stage ??
              (send.isPending ? '正在发…' : null) ??
              (files.uploading ? '文件还在上传…' : '发给 AI 修改')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
