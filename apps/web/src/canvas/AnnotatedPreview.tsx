// 能标注的预览（ADR 0012 §9）：图片、PDF 页（标注时用 pdf.js 一页一页画）、视频（暂停后在帧上画，
// 时间轴上的红点是批注）、音频（时间轴上加批注）。其他格式照常预览，意见在侧栏里写。
import type { Annotation, AnnotationShape } from '@oasis/contracts/canvas';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PreviewBody, type PreviewFile } from '../chat/FilePreview.tsx';
import { baseName } from '../chat/files.ts';
import { AnnotationLayer, type Tool } from './AnnotationLayer.tsx';
import { formatTime, type Surface } from './annotations.ts';

/** 新画好的一处：形状（音频没有）、第几页、第几秒 */
export interface Drawn {
  shape: AnnotationShape | null;
  page: number | null;
  time: number | null;
}

/** 从侧栏点一条批注：翻到那一页、跳到那一刻 */
export interface Jump {
  /** 哪一条批注：翻页、跳转后把它滚到画面中间 */
  id: string;
  page: number | null;
  time: number | null;
  nonce: number;
}

/** 把这条批注的编号滚到看得见的地方（编号带 data-annotation） */
function reveal(jump: Jump | null) {
  if (!jump) return;
  document
    .querySelector(`[data-annotation="${CSS.escape(jump.id)}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

interface Props {
  file: PreviewFile;
  surface: Surface;
  annotations: Annotation[];
  /** 标注模式下选中的工具；不在标注模式为 null */
  tool: Tool | null;
  annotating: boolean;
  pending: Drawn | null;
  onDraw: (drawn: Drawn) => void;
  jump: Jump | null;
}

/** 时间轴：批注处一个红点，点一下跳过去 */
function Timeline({
  duration,
  current,
  items,
  onSeek,
}: {
  duration: number;
  current: number;
  items: Annotation[];
  onSeek: (time: number) => void;
}) {
  if (!duration) return null;
  return (
    <div aria-label="批注时间轴" className="relative h-6 w-full max-w-3xl">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-track" />
      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-muted/40"
        style={{ width: `${Math.min(100, (current / duration) * 100)}%` }}
      />
      {items
        .filter((a) => a.time !== null)
        .map((a) => (
          <button
            key={a.id}
            type="button"
            aria-label={`跳到批注 ${a.number}（${formatTime(a.time!)}）`}
            onClick={() => onSeek(a.time!)}
            className="absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-0 bg-accent font-display text-[10px] text-on-accent"
            style={{ left: `${Math.min(100, (a.time! / duration) * 100)}%` }}
          >
            {a.number}
          </button>
        ))}
    </div>
  );
}

function MediaView({
  file,
  audio,
  annotations,
  tool,
  annotating,
  pending,
  onDraw,
  jump,
}: Props & { audio: boolean }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [state, setState] = useState({ duration: 0, current: 0, paused: true });
  const sync = () => {
    const el = media.current;
    if (el)
      setState({
        duration: Number.isFinite(el.duration) ? el.duration : 0,
        current: el.currentTime,
        paused: el.paused,
      });
  };
  const seek = (time: number) => {
    const el = media.current;
    if (!el) return;
    el.pause();
    el.currentTime = time;
    sync();
  };
  // 从侧栏点了一条批注：暂停并跳到那一刻（状态由 seeked / pause 事件同步）
  useEffect(() => {
    const el = media.current;
    if (jump?.time == null || !el) return;
    el.pause();
    el.currentTime = jump.time;
    reveal(jump);
  }, [jump]);
  // 暂停时，这一帧附近（半秒内）的批注显示在画面上
  const frame = annotations.filter(
    (a) => a.time !== null && Math.abs(a.time - state.current) < 0.5,
  );
  const events = {
    onLoadedMetadata: sync,
    onTimeUpdate: sync,
    onPause: sync,
    onPlay: sync,
    onSeeked: sync,
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      {audio ? (
        <audio ref={media} src={file.url} controls className="w-full max-w-xl" {...events} />
      ) : (
        <div className="relative inline-block max-w-full">
          <video
            ref={media}
            src={file.url}
            controls={!(annotating && state.paused && tool)}
            className="block max-h-[62vh] max-w-full rounded-item"
            {...events}
          />
          {state.paused && (
            <AnnotationLayer
              items={frame}
              tool={annotating ? tool : null}
              pending={pending?.shape ?? null}
              onDraw={(shape) => onDraw({ shape, page: null, time: state.current })}
            />
          )}
        </div>
      )}
      <Timeline
        duration={state.duration}
        current={state.current}
        items={annotations}
        onSeek={seek}
      />
      {annotating && (
        <p className="m-0 text-[12.5px] text-ink-muted">
          {audio
            ? `播放到要改的地方暂停，再点「在 ${formatTime(state.current)} 加批注」`
            : state.paused
              ? `在 ${formatTime(state.current)} 这一帧上圈画；要用播放器时把工具收起`
              : '暂停后可以在这一帧上圈画'}
        </p>
      )}
      {annotating && audio && (
        <button
          type="button"
          onClick={() => onDraw({ shape: null, page: null, time: state.current })}
          className="h-9 rounded-full border-0 bg-accent px-4 text-[13px] font-medium text-on-accent"
        >
          在 {formatTime(state.current)} 加批注
        </button>
      )}
    </div>
  );
}

function PdfView({ file, annotations, tool, pending, onDraw, jump }: Props) {
  const url = file.pdfUrl ?? file.url;
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<import('./pdf.ts').PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  useEffect(() => {
    let destroy = () => {};
    let alive = true;
    void import('./pdf.ts')
      .then(({ openPdf }) => {
        const opened = openPdf(url);
        destroy = opened.destroy;
        return opened.promise;
      })
      .then((d) => alive && setDoc(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
      destroy();
    };
  }, [url]);
  const jumpRef = useRef(jump);
  useEffect(() => {
    jumpRef.current = jump;
    if (jump?.page === page) reveal(jump);
  }, [jump, page]);
  useEffect(() => {
    if (!doc || !canvas.current) return;
    const width = (holder.current?.clientWidth ?? 900) * (window.devicePixelRatio || 1);
    void import('./pdf.ts')
      .then(({ renderPage }) => renderPage(doc, page, canvas.current!, Math.min(width, 2400)))
      // 页面画好、高度定了再滚到那条批注
      .then(() => reveal(jumpRef.current))
      .catch(() => setError(true));
  }, [doc, page]);
  // 从侧栏点了一条批注：翻到那一页（在渲染时跟着变，不用 effect）
  const [seenJump, setSeenJump] = useState(jump);
  if (jump !== seenJump) {
    setSeenJump(jump);
    if (jump?.page != null) setPage(jump.page);
  }
  if (error)
    return <p className="m-0 p-6 text-sm text-accent">这份 PDF 没能画出来，请下载后查看。</p>;
  const total = doc?.numPages ?? 0;
  return (
    <div ref={holder} className="flex h-full flex-col items-center gap-3 overflow-auto p-6">
      {!doc && <p className="m-0 text-sm text-ink-muted">正在打开…</p>}
      <div className="relative inline-block max-w-full">
        <canvas
          ref={canvas}
          aria-label={`${baseName(file.path)} 第 ${page} 页`}
          className="block h-auto max-w-full rounded-item bg-glass-active shadow-edge-strong"
        />
        {doc && (
          <AnnotationLayer
            items={annotations.filter((a) => a.page === page)}
            tool={tool}
            pending={pending?.page === page ? pending.shape : null}
            onDraw={(shape) => onDraw({ shape, page, time: null })}
          />
        )}
      </div>
      {total > 0 && (
        <div className="flex items-center gap-2 text-[13px]">
          <button
            type="button"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="flex size-9 items-center justify-center rounded-full border-0 bg-glass-active text-ink shadow-edge-strong disabled:opacity-40"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span>
            第 {page} / {total} 页
          </span>
          <button
            type="button"
            aria-label="下一页"
            disabled={page >= total}
            onClick={() => setPage(page + 1)}
            className="flex size-9 items-center justify-center rounded-full border-0 bg-glass-active text-ink shadow-edge-strong disabled:opacity-40"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

export function AnnotatedPreview(props: Props) {
  const { file, surface, annotations, tool, pending, onDraw, annotating, jump } = props;
  useEffect(() => {
    if (surface === 'image') reveal(jump);
  }, [surface, jump]);
  switch (surface) {
    case 'image':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="relative inline-block max-w-full">
            <img
              src={file.url}
              alt={baseName(file.path)}
              draggable={false}
              className="block max-h-[66vh] max-w-full rounded-item"
            />
            <AnnotationLayer
              items={annotations}
              tool={tool}
              pending={pending?.shape ?? null}
              onDraw={(shape) => onDraw({ shape, page: null, time: null })}
            />
          </div>
        </div>
      );
    case 'video':
    case 'audio':
      return <MediaView {...props} audio={surface === 'audio'} />;
    case 'pdf':
      // 不标注时仍用浏览器自带的 PDF 查看（能搜索、复制）；标注时由 pdf.js 一页一页画
      return annotating ? <PdfView {...props} /> : <PreviewBody file={file} />;
    default:
      return <PreviewBody file={file} />;
  }
}
