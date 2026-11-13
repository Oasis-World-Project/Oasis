// 工作流图的自动布局（纯函数）：从左到右分列。
// 每一块放在「最长上游链」那一列；同一列里按上游的平均位置排，减少交叉。
// 块的大小不一样（一个 AI 做的成果的框跟着任务清单变高，生产线的框装着它的节点），所以按各自的宽高排。
// 位置不存库：节点和连线一变就重新排，用户看到的总是整齐的图。

export const NODE_W = 184;
export const NODE_H = 96;
/** 一个 AI 做的成果的框：宽固定，高跟着里面的行数（至少留两行） */
export const AGENT_W = 264;
export const ROW_H = 22;
export const agentHeight = (rows: number) => 86 + Math.max(rows, 2) * ROW_H;
/** 生产线的框：标题栏的高度和四周的留白 */
export const LINE_TITLE = 40;
export const LINE_PAD = 16;
const GAP_X = 72;
const GAP_Y = 36;

export interface LayoutBox {
  id: string;
  w: number;
  h: number;
}

export interface LayoutLink {
  from: string;
  to: string;
}

export interface Layout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/** 每一块在第几列：没有上游的在第 0 列，其余是上游最大列 + 1（有环时不会死循环） */
function columns(ids: string[], links: LayoutLink[]): Map<string, number> {
  const known = new Set(ids);
  const preds = new Map(ids.map((id) => [id, [] as string[]]));
  for (const { from, to } of links) {
    if (known.has(from) && known.has(to)) preds.get(to)?.push(from);
  }
  const column = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = column.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ups = preds.get(id) ?? [];
    const value = ups.length === 0 ? 0 : Math.max(...ups.map(depth)) + 1;
    visiting.delete(id);
    column.set(id, value);
    return value;
  };
  ids.forEach(depth);
  return column;
}

export function layout(boxes: LayoutBox[], links: LayoutLink[]): Layout {
  const ids = boxes.map((b) => b.id);
  const size = new Map(boxes.map((b) => [b.id, b]));
  const column = columns(ids, links);
  const byColumn = new Map<number, string[]>();
  for (const id of ids) {
    const c = column.get(id) ?? 0;
    byColumn.set(c, [...(byColumn.get(c) ?? []), id]);
  }

  // 一列一列往右排：按上游在前面列里的平均行号排序，没有上游的保持原来的先后
  const row = new Map<string, number>();
  const order = [...byColumn.keys()].sort((a, b) => a - b);
  for (const c of order) {
    const weight = (id: string, index: number) => {
      const ups = links.filter((l) => l.to === id && row.has(l.from)).map((l) => row.get(l.from)!);
      return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : index;
    };
    const sorted = (byColumn.get(c) ?? [])
      .map((id, index) => ({ id, w: weight(id, index), index }))
      .sort((a, b) => a.w - b.w || a.index - b.index)
      .map(({ id }) => id);
    sorted.forEach((id, index) => row.set(id, index));
    byColumn.set(c, sorted);
  }

  // 每一列在竖直方向上居中；列宽取这一列里最宽的
  const heightOf = (list: string[]) =>
    list.reduce((sum, id) => sum + size.get(id)!.h, 0) + (list.length - 1) * GAP_Y;
  const height = Math.max(0, ...[...byColumn.values()].map(heightOf));
  const positions: Layout['positions'] = new Map();
  let x = 0;
  for (const c of order) {
    const list = byColumn.get(c) ?? [];
    let y = (height - heightOf(list)) / 2;
    for (const id of list) {
      positions.set(id, { x, y });
      y += size.get(id)!.h + GAP_Y;
    }
    x += Math.max(...list.map((id) => size.get(id)!.w)) + GAP_X;
  }
  return { positions, width: Math.max(0, x - GAP_X), height };
}
