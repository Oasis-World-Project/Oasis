// 成果页的预览加批注（ADR 0012 §9，外观照原型 ⑨⑩）：底部悬浮的工具条（标注 → 圈 / 画笔 / 点 / 完成），
// 右侧批注列表（点一条翻到那一页、跳到那一刻；标注时可以删）。画好一处就在侧栏写意见，写好立即保存。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Circle, Eraser, MapPin, MessageSquareText, PenLine, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { artifactQuery, saveAnnotations } from '../api/queries.ts';
import type { PreviewFile } from '../chat/FilePreview.tsx';
import { previewKindOf } from '../chat/files.ts';
import { AnnotatedPreview, type Drawn, type Jump } from './AnnotatedPreview.tsx';
import type { Tool } from './AnnotationLayer.tsx';
import { nextNumber, surfaceOf, whereOf } from './annotations.ts';

const TOOLS: { tool: Tool; label: string; Icon: typeof Circle }[] = [
  { tool: 'ellipse', label: '圈', Icon: Circle },
  { tool: 'pen', label: '画笔', Icon: PenLine },
  { tool: 'pin', label: '点', Icon: MapPin },
];

const barButton =
  'inline-flex h-9 items-center gap-1.5 rounded-full border-0 px-3.5 text-[13px] font-medium';

export function ArtifactReview({ artifact, file }: { artifact: ArtifactBody; file: PreviewFile }) {
  const queryClient = useQueryClient();
  const surface = surfaceOf(previewKindOf(artifact.path), !!file.pdfUrl);
  const visual = surface !== 'text' && surface !== 'audio';
  const [annotating, setAnnotating] = useState(false);
  const [panel, setPanel] = useState(false);
  const [tool, setTool] = useState<Tool>('ellipse');
  const [pending, setPending] = useState<Drawn | null>(null);
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState('');
  const [jump, setJump] = useState<Jump | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = artifact.annotations;

  const save = useMutation({
    mutationFn: (next: Annotation[]) => saveAnnotations(artifact.id, next),
    onSuccess: (body) => {
      queryClient.setQueryData(artifactQuery(artifact.id).queryKey, body);
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  const begin = (drawn: Drawn) => {
    if (nextNumber(list) === null) {
      setNotice('一份成果最多 50 条批注，先删掉几条');
      return;
    }
    setNotice(null);
    setPending(drawn);
    setNote('');
    setQuote('');
  };
  const cancel = () => setPending(null);
  function add(event: FormEvent) {
    event.preventDefault();
    const number = nextNumber(list);
    if (!pending || number === null || !note.trim()) return;
    save.mutate(
      [
        ...list,
        {
          id: crypto.randomUUID(),
          number,
          note: note.trim(),
          page: pending.page,
          time: pending.time,
          quote: quote.trim() ? quote.trim().slice(0, 300) : null,
          shape: pending.shape,
        },
      ],
      { onSuccess: () => setPending(null) },
    );
  }
  const remove = (id: string) => save.mutate(list.filter((a) => a.id !== id));
  const showPanel = annotating || panel;
  const pendingWhere = pending
    ? whereOf({ ...pending, id: '', number: 1, note: '', quote: null })
    : '';

  return (
    // 窄屏时批注栏放到预览下面，宽屏时放右边
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      <div className="relative min-h-[320px] min-w-0 flex-1 overflow-auto rounded-card bg-glass-active shadow-edge-strong">
        <AnnotatedPreview
          file={file}
          surface={surface}
          annotations={list}
          tool={annotating && visual && !pending ? tool : null}
          annotating={annotating}
          pending={pending}
          onDraw={begin}
          jump={jump}
        />
        <div
          role="toolbar"
          aria-label="标注工具"
          className="sticky bottom-3 mx-auto mb-3 flex w-fit max-w-[calc(100%-24px)] flex-wrap items-center justify-center gap-1 rounded-[22px] bg-glass-active p-1 shadow-panel backdrop-blur-xl"
        >
          {annotating ? (
            <>
              {visual &&
                TOOLS.map(({ tool: value, label, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={tool === value}
                    onClick={() => setTool(value)}
                    className={`${barButton} ${tool === value ? 'bg-solid text-on-solid' : 'bg-transparent text-ink'}`}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              {surface === 'text' && (
                <button
                  type="button"
                  onClick={() => begin({ shape: null, page: null, time: null })}
                  className={`${barButton} bg-transparent text-ink`}
                >
                  <MessageSquareText size={14} aria-hidden="true" />
                  加一条意见
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setAnnotating(false);
                  setPending(null);
                }}
                className={`${barButton} bg-accent text-on-accent`}
              >
                完成
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setAnnotating(true)}
                className={`${barButton} bg-accent text-on-accent`}
              >
                <PenLine size={14} aria-hidden="true" />
                标注
              </button>
              <button
                type="button"
                aria-pressed={panel}
                aria-label={`批注列表（${list.length} 条）`}
                onClick={() => setPanel(!panel)}
                className={`${barButton} bg-transparent text-ink`}
              >
                批注 {list.length}
              </button>
            </>
          )}
        </div>
      </div>
      {showPanel && (
        <aside
          aria-label="批注"
          className="flex max-h-[42%] w-full shrink-0 flex-col gap-3 overflow-auto rounded-card bg-glass-active p-4 shadow-edge-strong lg:max-h-none lg:w-[300px]"
        >
          <header className="flex items-center gap-2">
            <h2 className="m-0 flex-1 text-[15px] font-medium">批注（{list.length}）</h2>
            {!annotating && (
              <button
                type="button"
                aria-label="收起批注"
                onClick={() => setPanel(false)}
                className="flex size-8 items-center justify-center rounded-full border-0 bg-track text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </header>
          {notice && <p className="m-0 text-[12.5px] text-accent">{notice}</p>}
          {pending && (
            <form onSubmit={add} className="flex flex-col gap-2 rounded-item bg-glass-strong p-3">
              <span className="text-[12.5px] text-ink-muted">
                第 {nextNumber(list)} 条{pendingWhere ? ` · ${pendingWhere}` : ''}
              </span>
              <label className="flex flex-col gap-1">
                <span className="text-[12.5px] font-medium">这里要怎么改</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                  required
                  autoFocus
                  className="resize-y rounded-item border-0 bg-glass-active px-3 py-2 text-[13.5px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent"
                />
              </label>
              {surface === 'text' && (
                <label className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 text-[12.5px] font-medium">
                    引用原文（可选）
                    <button
                      type="button"
                      onClick={() =>
                        setQuote(window.getSelection()?.toString().trim().slice(0, 300) ?? '')
                      }
                      className="h-6 rounded-full border-0 bg-track px-2 text-[11.5px] text-ink"
                    >
                      用选中的文字
                    </button>
                  </span>
                  <input
                    aria-label="引用原文"
                    value={quote}
                    onChange={(e) => setQuote(e.target.value)}
                    maxLength={300}
                    className="rounded-item border-0 bg-glass-active px-3 py-2 text-[13px] text-ink shadow-edge-strong outline-none focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
              )}
              {save.isError && (
                <p role="alert" className="m-0 text-[12.5px] text-accent">
                  {save.error instanceof ApiError ? save.error.message : '没保存上，请重试'}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancel}
                  className="h-8 rounded-full border-0 bg-transparent px-3 text-[13px] text-ink-muted"
                >
                  算了
                </button>
                <button
                  type="submit"
                  disabled={!note.trim() || save.isPending}
                  className="h-8 rounded-full border-0 bg-accent px-4 text-[13px] font-medium text-on-accent disabled:opacity-45"
                >
                  加上
                </button>
              </div>
            </form>
          )}
          {list.length === 0 && !pending && (
            <p className="m-0 text-[13px] leading-relaxed text-ink-muted">
              {annotating
                ? visual
                  ? '在画面上圈出、画出或点出要改的地方，再写一句意见。'
                  : surface === 'audio'
                    ? '播放到要改的地方，点「在这里加批注」。'
                    : '点「加一条意见」，可以引用原文。'
                : '还没有批注。点「标注」标出要改的地方，攒好了再「发给 AI 修改」。'}
            </p>
          )}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {[...list]
              .sort((a, b) => a.number - b.number)
              .map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-2 rounded-item bg-glass-strong px-3 py-2"
                >
                  <button
                    type="button"
                    aria-label={`看批注 ${a.number}`}
                    onClick={() =>
                      setJump({ id: a.id, page: a.page, time: a.time, nonce: Date.now() })
                    }
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border-0 bg-accent font-display text-[11px] text-on-accent"
                  >
                    {a.number}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {whereOf(a) && (
                      <span className="text-[11.5px] text-ink-muted">{whereOf(a)}</span>
                    )}
                    <span className="break-words text-[13px] leading-relaxed">{a.note}</span>
                    {a.quote && (
                      <span className="break-words text-[12px] text-ink-muted">「{a.quote}」</span>
                    )}
                  </div>
                  {annotating && (
                    <button
                      type="button"
                      aria-label={`删除批注 ${a.number}`}
                      onClick={() => remove(a.id)}
                      disabled={save.isPending}
                      className="flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:text-ink"
                    >
                      <Eraser size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
