// 「让 AI 改」：写下修改意见、可附文件，连同这个话题里成果上的批注（圈画过的画面合成标注截图）
// 作为一条消息发到做这个成果的私聊里。系统把要改的成果交给 AI（还在它工作目录里的直接改，
// 之前话题做的拷一份进去），AI 接着改；改好的新版替换画布里的这一份。发出去后回到私聊看它改。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { MAX_ATTACHMENTS } from '@oasis/contracts/conversation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, sendMessage } from '../api/queries.ts';
import { uploadFile } from '../api/upload.ts';
import { PendingFiles } from '../chat/Attachments.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { revisionText, toRevisionNotes, type RevisionNote } from './annotations.ts';
import type { RevisionParameter } from './parameters.ts';
import { buildSnapshots, reviewName } from './snapshots.ts';

/** 标注截图最多带几张（和自己附的文件合计不超过一条消息的上限） */
const MAX_SNAPSHOTS = 8;

const field =
  'w-full rounded-item border-0 bg-glass-active px-3.5 py-2.5 text-[14px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent';

export function RevisePanel({
  artifact,
  siblings,
  parameters = [],
  onClose,
}: {
  /** 当前打开的成果 */
  artifact: ArtifactBody;
  /** 同一个话题的成果：上面的批注一起带上 */
  siblings: ArtifactBody[];
  /** 从参数面板来的成品参数 */
  parameters?: RevisionParameter[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal?.();
  }, []);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [request, setRequest] = useState('');
  const files = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const name = reviewName(artifact);
  // 这个话题的成果上的批注：默认一起带上
  const noted = siblings
    .filter((a) => a.annotations.length > 0)
    .map((a) => ({ ...a, name: reviewName(a) }));
  const noteCount = noted.reduce((n, a) => n + a.annotations.length, 0);
  const [withNotes, setWithNotes] = useState(true);
  const [stage, setStage] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      let notes: RevisionNote[] = [];
      const shots: string[] = [];
      if (withNotes && noteCount > 0) {
        setStage('正在合成标注截图…');
        const room = Math.min(MAX_SNAPSHOTS, MAX_ATTACHMENTS - files.ids.length);
        const built =
          room > 0
            ? await buildSnapshots(noted, siblings, room)
            : { files: [], nameOf: () => undefined };
        setStage('正在上传标注截图…');
        for (const shot of built.files) shots.push((await uploadFile(shot, () => {})).id);
        notes = toRevisionNotes(noted, built.nameOf);
      }
      setStage(null);
      // 要改的成果：当前这份，加上带了批注的
      const artifacts = [
        ...new Set([artifact.id, ...(notes.length ? noted.map((a) => a.id) : [])]),
      ];
      return sendMessage(artifact.conversationId, {
        content: revisionText(request.trim() || `改一下「${name}」`, notes, parameters),
        attachments: [...files.ids, ...shots],
        artifacts,
      });
    },
    onSettled: () => setStage(null),
    onSuccess: async () => {
      files.clear();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: messagesQuery(artifact.conversationId).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey }),
      ]);
      onClose();
      await navigate({
        to: '/dms/$conversationId',
        params: { conversationId: artifact.conversationId },
      });
    },
  });

  const ready =
    (request.trim().length > 0 || (withNotes && noteCount > 0) || parameters.length > 0) &&
    !files.uploading &&
    !files.failed;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready && !send.isPending) send.mutate();
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`让 AI 改「${name}」`}
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
            让 AI 改「{name}」
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
              maxLength={4000}
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
                带上这个话题里的 {noteCount} 条批注
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
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
            发到做这个成果的私聊里，AI
            接着改，只改你提到的地方；发出去后会回到私聊，可以看它改、随时插话。
            改好的新版替换画布里的这一份，上面的批注随之清掉。
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
              (files.uploading ? '文件还在上传…' : '发给 AI 改')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
