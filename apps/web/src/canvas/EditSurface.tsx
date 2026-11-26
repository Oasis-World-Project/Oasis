// 成果本身：看和改是同一个画面（成果页的「编辑」，照原型 ⑨–⑬）。进了「编辑」：
// 图片在图上点或拖框；PDF（Word、PPT 用配套的 PDF）一页一页翻着点；视频暂停在一帧上点，音频按时间点；
// 运行着的网页、应用、3D 模型切到「选取」后点（网页会报回点的是哪个按钮、哪段字）；文字和表格选一段原文。
// 已经记下的地方在画面上有编号；从右边清单点一条，翻到那一页、跳到那一刻。
import type { Annotation, AnnotationShape } from '@oasis/contracts/canvas';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PreviewBody, type PreviewFile } from '../chat/FilePreview.tsx';
import { baseName } from '../chat/files.ts';
import { EditLayer } from './EditLayer.tsx';
import { formatTime, type Surface } from './edits.ts';
import { PICK_REPLY, pickMessage } from './LivePreview.tsx';

/** 刚选的一处：在哪（还没说怎么改） */
export interface Place {
  shape: AnnotationShape | null;
  page: number | null;
  time: number | null;
  quote?: string | null;
  target?: string | null;
}

/** 从右边清单点一条：翻到那一页、跳到那一刻 */
export interface Jump {
  id: string;
  page: number | null;
  time: number | null;
  nonce: number;
}

/** 把这一处的编号滚到看得见的地方 */
function reveal(jump: Jump | null) {
  if (!jump) return;
  document
    .querySelector(`[data-edit="${CSS.escape(jump.id)}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

interface Props {
  file: PreviewFile;
  surface: Surface;
  edits: Annotation[];
  editing: boolean;
  /** 运行着的成果：现在点一下是选取（不是操作它） */
  picking: boolean;
  pending: Place | null;
  selected: string | null;
  onPlace: (place: Place) => void;
  onSelect: (id: string) => void;
  jump: Jump | null;
  /** 「直接调」的近似预览：视频滤镜、音量（只能调低）、倍速 */
  look?: { filter?: string; volume?: number; rate?: number };
  /** 运行中的应用本身（不传就按文件预览） */
  live?: ReactNode;
  /** 「这里要怎么改？」 */
  composer: ReactNode;
}

const ROUND =
  'flex size-9 cursor-pointer items-center justify-center rounded-full border-0 bg-glass-active text-ink shadow-edge-strong disabled:cursor-default disabled:opacity-40';
const ACTION =
  'h-9 cursor-pointer rounded-full border-0 bg-accent px-4 text-[13px] font-medium text-on-accent';

/** 时间轴：记下的地方各一个编号，点一下跳过去 */
function Timeline({
  duration,
  current,
  items,
  onSeek,
}: {
  duration: number;
  current: number;
  items: Annotation[];
  onSeek: (item: Annotation) => void;
}) {
  if (!duration) return null;
  return (
    <div role="group" aria-label="时间轴" className="relative h-6 w-full max-w-3xl">
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
            aria-label={`跳到第 ${a.number} 处（${formatTime(a.time!)}）`}
            onClick={() => onSeek(a)}
            className="absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-accent font-display text-[10px] text-on-accent"
            style={{ left: `${Math.min(100, (a.time! / duration) * 100)}%` }}
          >
            {a.number}
          </button>
        ))}
    </div>
  );
}

function MediaView(props: Props & { audio: boolean }) {
  const { file, audio, edits, editing, pending, selected, onPlace, onSelect, jump, look } = props;
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const volume = look?.volume,
    rate = look?.rate;
  useEffect(() => {
    if (media.current) media.current.volume = volume ?? 1;
  }, [volume]);
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    el.preservesPitch = true;
    el.playbackRate = rate ?? 1;
  }, [rate]);
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
  useEffect(() => {
    const el = media.current;
    if (jump?.time == null || !el) return;
    el.pause();
    el.currentTime = jump.time;
    reveal(jump);
  }, [jump]);
  const here = edits.filter((a) => a.time !== null && Math.abs(a.time - state.current) < 0.5);
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
            // 暂停着选地方时把播放器的控件收起来，免得点到它
            controls={!(editing && state.paused)}
            style={look?.filter ? { filter: look.filter } : undefined}
            className="block max-h-[58vh] max-w-full rounded-item"
            {...events}
          />
          {editing && state.paused && (
            <EditLayer
              items={here}
              active
              pending={pending?.shape ?? null}
              selected={selected}
              onDraw={(shape) => onPlace({ shape, page: null, time: round(state.current) })}
              onSelect={onSelect}
            >
              {props.composer}
            </EditLayer>
          )}
        </div>
      )}
      <Timeline
        duration={state.duration}
        current={state.current}
        items={edits}
        onSeek={(item) => {
          seek(item.time!);
          onSelect(item.id);
        }}
      />
      {editing && !audio && state.paused && (
        <button
          type="button"
          aria-label="接着播放"
          onClick={() => void media.current?.play()}
          className={ROUND}
        >
          <Play size={15} aria-hidden="true" />
        </button>
      )}
      {editing && audio && (
        <button
          type="button"
          onClick={() => {
            media.current?.pause();
            onPlace({ shape: null, page: null, time: round(state.current) });
          }}
          className={ACTION}
        >
          改这里（{formatTime(state.current)}）
        </button>
      )}
    </div>
  );
}
const round = (seconds: number) => Math.round(seconds * 100) / 100;

function PdfView(props: Props) {
  const { file, edits, pending, selected, onPlace, onSelect, jump } = props;
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
      .then(() => reveal(jumpRef.current))
      .catch(() => setError(true));
  }, [doc, page]);
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
          <EditLayer
            items={edits.filter((a) => a.page === page)}
            active
            pending={pending?.page === page ? pending.shape : null}
            selected={selected}
            onDraw={(shape) => onPlace({ shape, page, time: null })}
            onSelect={onSelect}
          >
            {props.composer}
          </EditLayer>
        )}
      </div>
      {total > 0 && (
        <div className="flex items-center gap-2 text-[13px]">
          <button
            type="button"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className={ROUND}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span>
            {page} / {total}
          </span>
          <button
            type="button"
            aria-label="下一页"
            disabled={page >= total}
            onClick={() => setPage(page + 1)}
            className={ROUND}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** 选中的形状（相对盖着的那一层）中心落在运行框里的哪（0–1）；不在框里返回 null */
function pointInFrame(layer: DOMRect, frame: DOMRect, shape: AnnotationShape) {
  const x = layer.left + (shape.kind === 'pin' ? shape.x : shape.x + shape.w / 2) * layer.width;
  const y = layer.top + (shape.kind === 'pin' ? shape.y : shape.y + shape.h / 2) * layer.height;
  const fx = (x - frame.left) / frame.width,
    fy = (y - frame.top) / frame.height;
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { x: fx, y: fy } : null;
}

/**
 * 运行着的网页、应用、3D 模型：平时照常点着用；进了「编辑」切到「选取」后，一层盖在上面接住点击。
 * 网页（运行框里的页面）会报回点的是什么（按钮「立即预约」这样一句）；问不到的只记画面上的位置。
 */
function LiveView(props: Props) {
  const { file, live, edits, editing, picking, pending, selected, onPlace, onSelect } = props;
  const holder = useRef<HTMLDivElement>(null);
  const place = (shape: AnnotationShape) => {
    const frame = holder.current?.querySelector('iframe');
    const layer = holder.current?.getBoundingClientRect();
    const at = frame && layer ? pointInFrame(layer, frame.getBoundingClientRect(), shape) : null;
    if (!frame?.contentWindow || !at) return onPlace({ shape, page: null, time: null });
    // 问运行框里的页面这一点上是什么；很快没回就不等了
    const id = crypto.randomUUID();
    const done = (target: string | null) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      onPlace({ shape, page: null, time: null, target });
    };
    const onMessage = (event: MessageEvent) => {
      const reply = (event.data as Record<string, { id?: string; label?: string }> | null)?.[
        PICK_REPLY
      ];
      if (event.source === frame.contentWindow && reply?.id === id) done(reply.label || null);
    };
    const timer = setTimeout(() => done(null), 400);
    window.addEventListener('message', onMessage);
    frame.contentWindow.postMessage(pickMessage(id, at.x, at.y), '*');
  };
  return (
    <div ref={holder} className="relative min-h-[560px] flex-1">
      <div className="absolute inset-0 flex flex-col">{live ?? <PreviewBody file={file} />}</div>
      {editing && (
        <EditLayer
          items={edits}
          active={picking}
          pending={pending?.shape ?? null}
          selected={selected}
          onDraw={place}
          onSelect={onSelect}
        >
          {props.composer}
        </EditLayer>
      )}
    </div>
  );
}

/** 文字、表格这类：选中一段原文，再点「改这一段」 */
function TextView({ file, live, editing, onPlace }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState(false);
  const quote = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim().replace(/\s+/g, ' ') ?? '';
    const inside =
      selection?.anchorNode && holder.current?.contains(selection.anchorNode) && text.length > 0;
    setNotice(!inside);
    if (inside) onPlace({ shape: null, page: null, time: null, quote: text.slice(0, 300) });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={holder} className="min-h-0 flex-1 overflow-auto">
        {live ?? <PreviewBody file={file} />}
      </div>
      {editing && (
        <div className="flex items-center justify-center gap-3 p-3">
          <button type="button" onClick={quote} className={ACTION}>
            改这一段
          </button>
          {notice && (
            <span role="status" className="text-[12.5px] text-accent">
              先在上面选中要改的那一段
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function EditSurface(props: Props) {
  const { file, surface, edits, editing, pending, selected, onPlace, onSelect, jump } = props;
  useEffect(() => {
    if (surface === 'image' || surface === 'live') reveal(jump);
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
            {editing && (
              <EditLayer
                items={edits}
                active
                pending={pending?.shape ?? null}
                selected={selected}
                onDraw={(shape) => onPlace({ shape, page: null, time: null })}
                onSelect={onSelect}
              >
                {props.composer}
              </EditLayer>
            )}
          </div>
        </div>
      );
    case 'video':
    case 'audio':
      return <MediaView {...props} audio={surface === 'audio'} />;
    case 'pdf':
      return editing ? <PdfView {...props} /> : <PreviewBody file={file} />;
    case 'live':
      return <LiveView {...props} />;
    default:
      return <TextView {...props} />;
  }
}
