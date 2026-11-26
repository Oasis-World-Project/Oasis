// 盖在画面上的一层（成果页的「编辑」）：点一下是一个点，拖一下是一个框；已经记下的地方各有一个编号（框的还画着框），
// 点编号在右边的清单里选中它。坐标都是相对画面的 0–1。刚选的那一处旁边放「这里要怎么改？」。
import type { Annotation, AnnotationShape } from '@oasis/contracts/canvas';
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { anchorOf, whereOf } from './edits.ts';

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;
/** 拖出来的框小于画面的这么多就当成点了一下 */
const TINY = 0.012;

function Frame({ shape, faint = false }: { shape: AnnotationShape; faint?: boolean }) {
  if (shape.kind !== 'box') return null;
  return (
    <span
      aria-hidden="true"
      className={`absolute rounded-[10px] border-2 border-solid border-accent bg-accent-tint ${faint ? 'opacity-70' : ''}`}
      style={{
        left: `${shape.x * 100}%`,
        top: `${shape.y * 100}%`,
        width: `${shape.w * 100}%`,
        height: `${shape.h * 100}%`,
      }}
    />
  );
}

export function EditLayer({
  items,
  active,
  pending,
  selected,
  onDraw,
  onSelect,
  children,
}: {
  /** 这张画面上已经记下的地方 */
  items: Annotation[];
  /** 现在点画面是在选地方（不是在操作下面的东西） */
  active: boolean;
  /** 刚选的、还没说怎么改的那一处 */
  pending: AnnotationShape | null;
  /** 清单里选中的那一条 */
  selected?: string | null;
  onDraw: (shape: AnnotationShape) => void;
  onSelect: (id: string) => void;
  /** 「这里要怎么改？」：放在刚选的那一处旁边 */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  const [draft, setDraft] = useState<AnnotationShape | null>(null);

  const point = (event: PointerEvent): [number, number] => {
    const rect = box.current!.getBoundingClientRect();
    return [
      round(clamp((event.clientX - rect.left) / rect.width)),
      round(clamp((event.clientY - rect.top) / rect.height)),
    ];
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || event.target !== event.currentTarget) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start.current = point(event);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    const to = point(event);
    setDraft({
      kind: 'box',
      x: Math.min(from[0], to[0]),
      y: Math.min(from[1], to[1]),
      w: round(Math.abs(to[0] - from[0])),
      h: round(Math.abs(to[1] - from[1])),
    });
  };
  const up = () => {
    const from = start.current;
    if (!from) return;
    start.current = null;
    const shape = draft;
    setDraft(null);
    onDraw(
      shape?.kind === 'box' && shape.w >= TINY && shape.h >= TINY
        ? shape
        : { kind: 'pin', x: from[0], y: from[1] },
    );
  };
  const at = pending ? anchorOf(pending) : null;
  const below = pending?.kind === 'box' ? pending.y + pending.h : (at?.[1] ?? 0);

  return (
    <div
      ref={box}
      aria-label={active ? '在画面上点一下或拖一个框' : undefined}
      className={`absolute inset-0 ${active ? 'cursor-crosshair touch-none' : 'pointer-events-none'}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {items.map((a) => (a.shape ? <Frame key={a.id} shape={a.shape} /> : null))}
      {draft && <Frame shape={draft} faint />}
      {pending && <Frame shape={pending} faint />}
      {items.map((a) => {
        if (!a.shape) return null;
        const [x, y] = anchorOf(a.shape);
        return (
          <button
            key={a.id}
            type="button"
            data-edit={a.id}
            aria-label={`第 ${a.number} 处：${whereOf(a)}`}
            aria-current={selected === a.id ? 'true' : undefined}
            onClick={() => onSelect(a.id)}
            className={`pointer-events-auto absolute flex size-[26px] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-accent font-display text-[11px] font-medium text-on-accent shadow-raised ${
              selected === a.id ? 'ring-4 ring-accent-tint' : ''
            }`}
            style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          >
            {a.number}
          </button>
        );
      })}
      {at && pending?.kind === 'pin' && (
        <span
          aria-hidden="true"
          className="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_5px_var(--oasis-accent-tint)]"
          style={{ left: `${at[0] * 100}%`, top: `${at[1] * 100}%` }}
        />
      )}
      {at && children && (
        <div
          className="pointer-events-auto absolute z-10 w-[300px] max-w-[90%]"
          style={{
            left: `${Math.min(at[0], 0.6) * 100}%`,
            // 靠下的地方把框放在上面，免得伸出画面
            ...(below > 0.66
              ? { bottom: `calc(${(1 - at[1]) * 100}% + 10px)` }
              : { top: `calc(${below * 100}% + 10px)` }),
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
