// 子节点（ADR 0026）：展开节点按上游的清单每条开一个子节点，做几版的节点每版开一个子节点。
// 工作流图里只有根节点（没有 parentId），连线只连根节点；子节点跟着父节点开跑，做完后父节点汇总（展开）
// 或挑一版（做几版）。父节点自己不跑、不占并发名额，所以叫「组节点」。这里放不碰数据库的小工具。
import { createHash } from 'node:crypto';
import { FOREACH_MAX } from '@oasis/contracts/task';
import type { Node } from '../repo/task-store.ts';

/** 条目号、目录名：01、02……（和下游 in/<展开节点>/01/ 一致） */
export const pad2 = (n: number) => String(n).padStart(2, '0');

/** 做几版挑一版的节点 */
export const hasVariants = (node: Pick<Node, 'config'>) => (node.config.variants?.n ?? 0) > 1;

/** 组节点：展开节点、做几版的节点。它们自己不跑，不占并发名额 */
export const isGroup = (node: Pick<Node, 'kind' | 'config'>) =>
  node.kind === 'foreach' || hasVariants(node);

/** 工作流图里的节点（不是谁的子节点） */
export const isRoot = (node: Pick<Node, 'parentId'>) => !node.parentId;

/** 工具子节点：单独一个并发池（用户 2026-11-08：工具子节点最多 6 个同时跑） */
export const isToolChild = (node: Pick<Node, 'parentId' | 'kind' | 'config'>) =>
  Boolean(node.parentId) && node.kind === 'tool' && !isGroup(node);

/** 某个节点的子节点，按条目号 / 版本号排 */
export const childrenOf = (nodes: Node[], parent: Pick<Node, 'id'>) =>
  nodes.filter((n) => n.parentId === parent.id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

/** 子节点往上找到的工作流图里的节点（自己就是根节点时返回自己） */
export function rootOf(nodes: Node[], node: Node): Node {
  let current = node;
  for (let depth = 0; current.parentId && depth < 8; depth += 1) {
    const parent = nodes.find((n) => n.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** 第几层：根节点 0，展开出来的一条 1，那一条做的某一版 2 */
export const depthOf = (nodes: Node[], node: Node) => {
  let depth = 0;
  for (let n: Node | undefined = node; n?.parentId; depth += 1)
    n = nodes.find((x) => x.id === n!.parentId);
  return depth;
};

/** 某个节点下面的全部节点（子节点、子节点的子节点） */
export function descendantsOf(nodes: Node[], node: Pick<Node, 'id'>): Node[] {
  const found: Node[] = [];
  for (const child of nodes.filter((n) => n.parentId === node.id))
    found.push(child, ...descendantsOf(nodes, child));
  return found;
}

/** 没被占用的节点名：base 被占了就加 -2、-3…… */
export function freeKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const TEMPLATE = /\{\{\s*(index|item)((?:\.[\p{L}\p{N}_-]+)*)\s*\}\}/gu;

/** 字符串里有没有 {{index}}、{{item}} 这类模板 */
export const hasTemplate = (value: unknown) => /\{\{/.test(JSON.stringify(value) ?? '');

/**
 * 把展开的做法套到一条上：字符串里的 {{index}} 换成两位数的条目号，{{item}} 换成这一条（不是文字就写成 JSON），
 * {{item.字段}} 换成这一条的某个字段。缺的字段记下来。
 */
export function fillTemplate<T>(value: T, index: number, item: unknown, missing: string[] = []): T {
  if (typeof value === 'string')
    return value.replace(TEMPLATE, (whole: string, name: string, path: string) => {
      if (name === 'index') return pad2(index);
      let found: unknown = item;
      for (const key of path.split('.').filter(Boolean))
        found =
          found && typeof found === 'object' ? (found as Record<string, unknown>)[key] : undefined;
      if (found === undefined || found === null) {
        missing.push(whole);
        return '';
      }
      return typeof found === 'string' ? found : JSON.stringify(found);
    }) as T;
  if (Array.isArray(value))
    return value.map((v: unknown) => fillTemplate(v, index, item, missing)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillTemplate(v, index, item, missing)]),
    ) as T;
  return value;
}

/** 上游交来的清单 → 条目：JSON 数组，或只含一个数组的对象（如 {"shots":[…]}）；1 到 24 条 */
export function listItems(text: string): { items: unknown[] } | { problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: '不是合法的 JSON' };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) data = arrays[0];
  }
  if (!Array.isArray(data)) return { problem: '要是一个 JSON 数组（或只含一个数组的对象）' };
  if (!data.length) return { problem: '是空的，一条也没有' };
  if (data.length > FOREACH_MAX)
    return { problem: `有 ${data.length} 条，一次最多展开 ${FOREACH_MAX} 条` };
  return { items: data };
}

/**
 * 一条的指纹：这一条的内容、做法、它用到的上游产出。重新展开（修改）时指纹没变、上次做成了的沿用。
 */
export const itemHash = (item: unknown, each: unknown, inputs: string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ item, each, inputs: [...inputs].sort() }))
    .digest('hex');

/** 方案里的展开节点、做几版的节点的名字后面要接 -01、-v1 之类，留出位置 */
export const GROUP_KEY_MAX = 34;
