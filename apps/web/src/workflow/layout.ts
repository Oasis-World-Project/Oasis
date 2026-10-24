// 工作流图的自动布局（纯函数）：从左到右分层。
// 每个节点放在「最长上游链」那一列；同一列里按上游的平均位置排，减少交叉。
// 位置不存库：节点和连线一变就重新排，用户看到的总是整齐的图。

export const NODE_W = 184;
export const NODE_H = 96;
const GAP_X = 72;
const GAP_Y = 36;

export interface LayoutLink {
  from: string;
  to: string;
}

export type Positions = Map<string, { x: number; y: number }>;

/** 每个节点在第几列：没有上游的在第 0 列，其余是上游最大列 + 1（有环时不会死循环） */
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

export function layout(ids: string[], links: LayoutLink[]): Positions {
  const column = columns(ids, links);
  const byColumn = new Map<number, string[]>();
  for (const id of ids) {
    const c = column.get(id) ?? 0;
    byColumn.set(c, [...(byColumn.get(c) ?? []), id]);
  }

  // 一列一列往右排：按上游在前一列里的平均行号排序，没有上游的保持原来的先后
  const row = new Map<string, number>();
  const order = [...byColumn.keys()].sort((a, b) => a - b);
  for (const c of order) {
    const list = byColumn.get(c) ?? [];
    const weight = (id: string, index: number) => {
      const ups = links.filter((l) => l.to === id && row.has(l.from)).map((l) => row.get(l.from)!);
      return ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : index;
    };
    const sorted = list
      .map((id, index) => ({ id, w: weight(id, index), index }))
      .sort((a, b) => a.w - b.w || a.index - b.index);
    sorted.forEach(({ id }, index) => row.set(id, index));
  }

  // 每一列在竖直方向上居中
  const tallest = Math.max(1, ...[...byColumn.values()].map((l) => l.length));
  const positions: Positions = new Map();
  for (const [c, list] of byColumn) {
    const offset = ((tallest - list.length) * (NODE_H + GAP_Y)) / 2;
    for (const id of list) {
      positions.set(id, {
        x: c * (NODE_W + GAP_X),
        y: offset + (row.get(id) ?? 0) * (NODE_H + GAP_Y),
      });
    }
  }
  return positions;
}
