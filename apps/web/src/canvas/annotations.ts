// 批注的纯逻辑（ADR 0012 §9）：编号、位置的说法、编号画在哪、在一张画布上画出来（合成标注截图）。
import { MAX_ANNOTATIONS, type Annotation, type AnnotationShape } from '@oasis/contracts/canvas';
import type { RevisionNote } from '@oasis/contracts/conversation';
import type { PreviewKind } from '../chat/files.ts';

/** 能在画面上圈画的类型；其余只能写意见（可带引用原文）。app：运行中的网页或应用，截下当前画面再圈画（只有桌面版能截） */
export type Surface = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'app';

export function surfaceOf(kind: PreviewKind, hasPdf: boolean): Surface {
  if (kind === 'image' || kind === 'video' || kind === 'audio') return kind;
  if (kind === 'pdf' || (kind === 'presentation' && hasPdf)) return 'pdf';
  return 'text';
}

/** 下一个编号：用掉的最小空位，满了返回 null */
export function nextNumber(list: Annotation[]): number | null {
  if (list.length >= MAX_ANNOTATIONS) return null;
  const used = new Set(list.map((a) => a.number));
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return null;
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** 编号画在哪：编号点就在点上，圈在左上角，画笔在起笔处 */
export function anchorOf(shape: AnnotationShape): [number, number] {
  if (shape.kind === 'pin') return [shape.x, shape.y];
  if (shape.kind === 'ellipse') return [shape.x, shape.y];
  return shape.points[0]!;
}

/** 形状中心落在画面九宫格的哪一格 */
function regionOf(shape: AnnotationShape): string {
  let x: number, y: number;
  if (shape.kind === 'pin') [x, y] = [shape.x, shape.y];
  else if (shape.kind === 'ellipse') [x, y] = [shape.x + shape.w / 2, shape.y + shape.h / 2];
  else {
    x = shape.points.reduce((s, p) => s + p[0], 0) / shape.points.length;
    y = shape.points.reduce((s, p) => s + p[1], 0) / shape.points.length;
  }
  const col = x < 1 / 3 ? '左' : x > 2 / 3 ? '右' : '';
  const row = y < 1 / 3 ? '上' : y > 2 / 3 ? '下' : '';
  return `画面${col + row || '中间'}`;
}

/** 给人和 AI 看的位置：第几页、几分几秒、第几张截图、画面哪一块（frames 是 frameOrder 的结果） */
export function whereOf(a: Annotation, frames: string[] = []): string {
  const shot = a.frame ? frames.indexOf(a.frame) : -1;
  return [
    shot >= 0 ? `截图 ${shot + 1}` : '',
    a.page !== null ? `第 ${a.page} 页` : '',
    a.time !== null ? formatTime(a.time) : '',
    a.shape ? regionOf(a.shape) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 网页、应用：桌面版能截图时在截图上圈画，否则只能写意见 */
export function liveSurface(canCapture: boolean): Surface {
  return canCapture ? 'app' : 'text';
}

/** 同一张画面（同一页、同一时刻、同一张截图）上的批注合成一张截图 */
export const frameKey = (a: Annotation) =>
  a.frame
    ? `f${a.frame}`
    : a.page !== null
      ? `p${a.page}`
      : a.time !== null
        ? `t${a.time.toFixed(2)}`
        : 'image';

/** 截图按第一次出现的编号排序：第 1 张、第 2 张… */
export function frameOrder(list: Annotation[]): string[] {
  const order: string[] = [];
  for (const a of [...list].sort((x, y) => x.number - y.number))
    if (a.frame && !order.includes(a.frame)) order.push(a.frame);
  return order;
}

/** 发给 AI 的批注：按文件、编号排好 */
export function toRevisionNotes(
  files: { name: string; annotations: Annotation[] }[],
  snapshotName: (file: string, a: Annotation) => string | undefined,
): RevisionNote[] {
  return files.flatMap((file) =>
    [...file.annotations]
      .sort((a, b) => a.number - b.number)
      .map((a) => {
        const snapshot = snapshotName(file.name, a);
        return {
          file: file.name,
          number: a.number,
          where: whereOf(a, frameOrder(file.annotations)),
          note: a.note,
          ...(a.quote ? { quote: a.quote } : {}),
          ...(snapshot ? { snapshot } : {}),
        };
      }),
  );
}

/** 批注的颜色取设计令牌（画布上不能直接用 CSS 变量） */
function token(name: 'accent' | 'on-accent'): string {
  if (typeof document === 'undefined') return 'currentColor';
  return (
    getComputedStyle(document.documentElement).getPropertyValue(`--oasis-${name}`).trim() ||
    'currentColor'
  );
}

/** 在一张已经画好画面的画布上叠加圈画和编号（合成标注截图用） */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  list: Annotation[],
): void {
  const color = token('accent');
  const line = Math.max(2, Math.round(Math.min(width, height) / 300));
  const radius = Math.max(10, Math.round(Math.min(width, height) / 45));
  ctx.save();
  ctx.lineWidth = line;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const a of list) {
    const shape = a.shape;
    if (!shape) continue;
    if (shape.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        (shape.x + shape.w / 2) * width,
        (shape.y + shape.h / 2) * height,
        Math.max(1, (shape.w / 2) * width),
        Math.max(1, (shape.h / 2) * height),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (shape.kind === 'pen') {
      ctx.beginPath();
      shape.points.forEach(([x, y], i) =>
        i ? ctx.lineTo(x * width, y * height) : ctx.moveTo(x * width, y * height),
      );
      ctx.stroke();
    }
    const [ax, ay] = anchorOf(shape);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(ax * width, ay * height, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = token('on-accent');
    ctx.font = `600 ${Math.round(radius * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(a.number), ax * width, ay * height + 1);
  }
  ctx.restore();
}
