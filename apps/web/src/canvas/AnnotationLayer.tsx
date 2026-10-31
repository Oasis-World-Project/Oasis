// 盖在画面（图片、PDF 页、暂停的视频帧）上的一层（ADR 0012 §9）：标注模式下拖出圈、画笔画、点编号点；
// 平时只显示编号，点编号才显示意见（原型：批注默认隐藏）。坐标都是相对画面的 0–1。
import type { Annotation, AnnotationShape } from '@oasis/contracts/canvas';
import { useRef, useState, type PointerEvent } from 'react';
import { anchorOf } from './annotations.ts';

export type Tool = 'ellipse' | 'pen' | 'pin';

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

function Shape({ shape, faint = false }: { shape: AnnotationShape; faint?: boolean }) {
  const common = {
    fill: 'none',
    vectorEffect: 'non-scaling-stroke' as const,
    strokeWidth: 2.5,
    className: `stroke-accent ${faint ? 'opacity-60' : ''}`,
  };
  if (shape.kind === 'ellipse')
    return (
      <ellipse
        {...common}
        cx={shape.x + shape.w / 2}
        cy={shape.y + shape.h / 2}
        rx={shape.w / 2}
        ry={shape.h / 2}
      />
    );
  if (shape.kind === 'pen')
    return (
      <polyline
        {...common}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={shape.points.map(([x, y]) => `${x},${y}`).join(' ')}
      />
    );
  return null;
}

export function AnnotationLayer({
  items,
  tool,
  onDraw,
  pending,
}: {
  items: Annotation[];
  /** 标注模式下选中的工具；null 时这一层不挡住下面的画面（视频控件照常能用） */
  tool: Tool | null;
  onDraw: (shape: AnnotationShape) => void;
  /** 画好了、还没写意见的那一处 */
  pending: AnnotationShape | null;
}) {
  const box = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<AnnotationShape | null>(null);
  const start = useRef<[number, number] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const point = (event: PointerEvent): [number, number] => {
    const rect = box.current!.getBoundingClientRect();
    return [
      round(clamp((event.clientX - rect.left) / rect.width)),
      round(clamp((event.clientY - rect.top) / rect.height)),
    ];
  };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (!tool) return;
    event.preventDefault();
    const p = point(event);
    if (tool === 'pin') {
      onDraw({ kind: 'pin', x: p[0], y: p[1] });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = p;
    setDraft(tool === 'pen' ? { kind: 'pen', points: [p, p] } : null);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const from = start.current;
    if (!from || !tool) return;
    const p = point(event);
    if (tool === 'pen')
      setDraft((d) =>
        d?.kind === 'pen' && d.points.length < 400 ? { ...d, points: [...d.points, p] } : d,
      );
    else
      setDraft({
        kind: 'ellipse',
        x: Math.min(from[0], p[0]),
        y: Math.min(from[1], p[1]),
        w: round(Math.abs(p[0] - from[0])),
        h: round(Math.abs(p[1] - from[1])),
      });
  };
  const up = () => {
    const shape = draft;
    start.current = null;
    setDraft(null);
    // 太小的圈当作点了一下，不算
    if (shape?.kind === 'ellipse' && (shape.w < 0.01 || shape.h < 0.01)) return;
    if (shape?.kind === 'pen' && shape.points.length < 3) return;
    if (shape) onDraw(shape);
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      <svg
        ref={box}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-label={tool ? '在画面上标注' : undefined}
        className={`absolute inset-0 size-full ${tool ? 'pointer-events-auto cursor-crosshair touch-none' : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {items.map((a) => (a.shape ? <Shape key={a.id} shape={a.shape} /> : null))}
        {draft && <Shape shape={draft} faint />}
        {pending && <Shape shape={pending} faint />}
      </svg>
      {items.map((a) => {
        if (!a.shape) return null;
        const [x, y] = anchorOf(a.shape);
        return (
          <div
            key={a.id}
            data-annotation={a.id}
            className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          >
            <button
              type="button"
              aria-label={`第 ${a.number} 条批注`}
              aria-expanded={open === a.id}
              onClick={() => setOpen(open === a.id ? null : a.id)}
              className="flex size-6 items-center justify-center rounded-full border-0 bg-accent font-display text-[11px] font-medium text-on-accent shadow-raised"
            >
              {a.number}
            </button>
            {open === a.id && (
              <p
                role="note"
                className="absolute left-7 top-0 z-10 m-0 w-56 rounded-item bg-glass-active px-3 py-2 text-[13px] leading-relaxed text-ink shadow-panel"
              >
                {a.note}
              </p>
            )}
          </div>
        );
      })}
      {pending && (
        <span
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
          style={{
            left: `${anchorOf(pending)[0] * 100}%`,
            top: `${anchorOf(pending)[1] * 100}%`,
          }}
        />
      )}
    </div>
  );
}
