// 成果页的预览加批注（ADR 0012 §9，外观照原型 ⑨⑩）：顶栏的批注图标打开批注模式——底部悬浮工具条（圈 / 画笔 / 点 / 完成），
// 右侧批注列表（点一条翻到那一页、跳到那一刻；可以删），画好一处就在侧栏写意见，写好立即保存；列表底部「发给 AI 修改」。
import type { Annotation, ArtifactBody } from '@oasis/contracts/canvas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RevisionParameter } from '@oasis/contracts/conversation';
import {
  Camera,
  Circle,
  Eraser,
  MapPin,
  MessageSquareText,
  MousePointer2,
  PenLine,
  Send,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { artifactQuery, saveAnnotations } from '../api/queries.ts';
import { uploadFile } from '../api/upload.ts';
import { desktop } from '../desktop/sync.ts';
import type { PreviewFile } from '../chat/FilePreview.tsx';
import { previewKindOf } from '../chat/files.ts';
import { AnnotatedPreview, type Drawn, type Jump } from './AnnotatedPreview.tsx';
import type { Tool } from './AnnotationLayer.tsx';
import { frameOrder, liveSurface, nextNumber, surfaceOf, whereOf } from './annotations.ts';
import { ParameterPanel } from './ParameterPanel.tsx';
import { fieldsFor, mediaLook, type Values } from './parameters.ts';

const TOOLS: { tool: Tool; label: string; Icon: typeof Circle }[] = [
  { tool: 'ellipse', label: '圈', Icon: Circle },
  { tool: 'pen', label: '画笔', Icon: PenLine },
  { tool: 'pin', label: '点', Icon: MapPin },
];

const barButton =
  'inline-flex h-9 items-center gap-1.5 rounded-full border-0 px-3.5 text-[13px] font-medium';

/** 能在浏览器里近似预览的参数（告诉用户哪些改了能直接看到） */
const PREVIEWABLE: Partial<Record<string, string[]>> = {
  video: ['亮度', '色温'],
  audio: ['语速', '音量（只能听到调低）'],
};

export function ArtifactReview({
  artifact,
  file,
  annotating,
  onAnnotating,
  onRevise,
  live,
}: {
  artifact: ArtifactBody;
  file: PreviewFile;
  /** 可运行应用本身（静态应用的运行框或容器预览）；网页文件不用传，按文件预览运行 */
  live?: ReactNode;
  /** 批注模式由顶栏的批注图标开关 */
  annotating: boolean;
  onAnnotating: (on: boolean) => void;
  /** 「按这些参数改一版」：交给发给 AI 修改的对话框 */
  onRevise?: (parameters: RevisionParameter[]) => void;
}) {
  const queryClient = useQueryClient();
  const kind = previewKindOf(artifact.path);
  // 网页和应用在运行；桌面版能截下当前画面来画，浏览器里只能写意见
  const capturable = !!desktop()?.capturePage;
  const surface =
    live || kind === 'page' ? liveSurface(capturable) : surfaceOf(kind, !!file.pdfUrl);
  const fields = onRevise ? fieldsFor(kind) : [];
  const [values, setValues] = useState<Values>({});
  /** 参数面板（不在批注模式时） */
  const [params, setParams] = useState(false);
  const [tool, setTool] = useState<Tool>('ellipse');
  const [pending, setPending] = useState<Drawn | null>(null);
  const frames = frameOrder(artifact.annotations);
  /** 正在看的截图；null 时是应用本身 */
  const [frame, setFrame] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  /** 刚点开批注、第一张截图还没好：先别弹出侧栏，免得画面变窄后才截 */
  const [entering, setEntering] = useState(false);
  const [wasAnnotating, setWasAnnotating] = useState(annotating);
  if (annotating !== wasAnnotating) {
    setWasAnnotating(annotating);
    if (annotating && surface === 'app') setEntering(true);
    if (!annotating) {
      setFrame(null);
      setPending(null);
      setCaptureError(null);
    }
  }
  const visual = surface === 'app' ? frame !== null : surface !== 'text' && surface !== 'audio';
  const holder = useRef<HTMLDivElement>(null);
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
          frame: pending.frame ?? null,
        },
      ],
      { onSuccess: () => setPending(null) },
    );
  }
  const remove = (id: string) => save.mutate(list.filter((a) => a.id !== id));
  /** 截下应用当前的画面（只截运行框那一块），存成上传文件，然后盖在应用上画 */
  async function capture() {
    const bridge = desktop();
    const target =
      holder.current?.querySelector('[data-live-app] iframe, [data-live-app] img') ??
      holder.current?.querySelector('[data-live-app]');
    if (!bridge?.capturePage || !target) return;
    setCapturing(true);
    setCaptureError(null);
    try {
      const rect = target.getBoundingClientRect();
      const png = await bridge.capturePage({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      const shot = new File([png as Uint8Array<ArrayBuffer>], '批注截图.png', {
        type: 'image/png',
      });
      setFrame((await uploadFile(shot, () => {})).id);
    } catch (err) {
      setCaptureError(err instanceof ApiError ? err.message : '没截到画面，请重试');
    } finally {
      setCapturing(false);
      setEntering(false);
    }
  }
  // 点开批注时先截一张：截的是用户此刻看到的画面（侧栏弹出、画面变窄之前）
  useEffect(() => {
    if (entering) void capture();
    // 只在进入批注时截一次（capture 每次渲染都是新函数，不放进依赖）
  }, [entering]);
  const showPanel = annotating && !entering;
  // 还没写意见的这一处如果在新截图上，这张截图排在已有的后面
  const pendingFrames =
    pending?.frame && !frames.includes(pending.frame) ? [...frames, pending.frame] : frames;
  const pendingWhere = pending
    ? whereOf(
        { ...pending, frame: pending.frame ?? null, id: '', number: 1, note: '', quote: null },
        pendingFrames,
      )
    : '';

  return (
    // 窄屏时批注栏放到预览下面，宽屏时放右边
    <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      <div
        ref={holder}
        // 运行中的应用占满这一块，工具条排在它下面
        className={`relative min-h-[320px] min-w-0 flex-1 overflow-auto rounded-card bg-glass-active shadow-edge-strong ${surface === 'app' ? 'flex flex-col' : ''}`}
      >
        <AnnotatedPreview
          file={file}
          surface={surface}
          live={live}
          frame={frame}
          annotations={list}
          tool={annotating && visual && !pending ? tool : null}
          annotating={annotating}
          pending={pending}
          onDraw={begin}
          jump={jump}
          look={mediaLook(values)}
        />
        {(annotating || fields.length > 0) && (
          <div
            role="toolbar"
            aria-label="标注工具"
            // 3D 预览自带一排操作按钮，悬浮的工具条会盖住它们，所以排在预览下面
            className={`${kind === 'model' || surface === 'app' ? 'relative mt-2' : 'sticky bottom-3'} mx-auto mb-3 flex w-fit max-w-[calc(100%-24px)] flex-wrap items-center justify-center gap-1 rounded-[22px] bg-glass-active p-1 shadow-panel backdrop-blur-xl`}
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
                {surface === 'app' &&
                  (frame ? (
                    <button
                      type="button"
                      onClick={() => {
                        setFrame(null);
                        setPending(null);
                      }}
                      className={`${barButton} bg-transparent text-ink`}
                    >
                      <MousePointer2 size={14} aria-hidden="true" />
                      回到操作
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void capture()}
                      disabled={capturing}
                      className={`${barButton} bg-transparent text-ink disabled:opacity-50`}
                    >
                      <Camera size={14} aria-hidden="true" />
                      {capturing ? '正在截取…' : '截取当前画面'}
                    </button>
                  ))}
                {(surface === 'text' || (surface === 'app' && !frame)) && (
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
                    onAnnotating(false);
                    setPending(null);
                  }}
                  className={`${barButton} bg-accent text-on-accent`}
                >
                  完成
                </button>
              </>
            ) : (
              <button
                type="button"
                aria-pressed={params}
                onClick={() => setParams(!params)}
                className={`${barButton} ${params ? 'bg-solid text-on-solid' : 'bg-transparent text-ink'}`}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                参数
              </button>
            )}
          </div>
        )}
      </div>
      {showPanel && (
        <aside
          aria-label="批注"
          className="flex max-h-[42%] w-full shrink-0 flex-col gap-3 overflow-auto rounded-card bg-glass-active p-4 shadow-edge-strong lg:max-h-none lg:w-[300px]"
        >
          <header className="flex items-center gap-2">
            <h2 className="m-0 flex-1 text-[15px] font-medium">批注（{list.length}）</h2>
            <button
              type="button"
              aria-label="收起批注"
              onClick={() => {
                onAnnotating(false);
                setPending(null);
              }}
              className="flex size-8 items-center justify-center rounded-full border-0 bg-track text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          {notice && <p className="m-0 text-[12.5px] text-accent">{notice}</p>}
          {captureError && (
            <p role="alert" className="m-0 text-[12.5px] text-accent">
              {captureError}
            </p>
          )}
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
                ? surface === 'app'
                  ? frame
                    ? '在截图上圈出、画出或点出要改的地方，再写一句意见。想换个角度：回到操作，调好后再截一张。'
                    : '调好画面后点「截取当前画面」，在截图上圈画；也可以直接加一条意见。'
                  : visual
                    ? '在画面上圈出、画出或点出要改的地方，再写一句意见。'
                    : surface === 'audio'
                      ? '播放到要改的地方暂停，再点播放器下面的「在 … 加批注」。'
                      : '点「加一条意见」，可以引用原文。'
                : '还没有批注。'}
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
                    onClick={() => {
                      if (a.frame) setFrame(a.frame);
                      setJump({ id: a.id, page: a.page, time: a.time, nonce: Date.now() });
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full border-0 bg-accent font-display text-[11px] text-on-accent"
                  >
                    {a.number}
                  </button>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {whereOf(a, frames) && (
                      <span className="text-[11.5px] text-ink-muted">{whereOf(a, frames)}</span>
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
          {onRevise && (
            <button
              type="button"
              onClick={() => onRevise([])}
              className="mt-auto inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border-0 bg-accent px-4 text-[13.5px] font-medium text-on-accent"
            >
              <Send size={14} aria-hidden="true" />
              发给 AI 修改
            </button>
          )}
        </aside>
      )}
      {!showPanel && params && onRevise && (
        <ParameterPanel
          file={artifact.name}
          fields={fields}
          values={values}
          onChange={setValues}
          onRevise={onRevise}
          onClose={() => setParams(false)}
          previewable={PREVIEWABLE[kind] ?? []}
        />
      )}
    </div>
  );
}
