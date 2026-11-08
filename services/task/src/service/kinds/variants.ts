// 干活节点、工具节点都能「做几版挑一版」（ADR 0026）：这里是两者共用的方案、估价和编辑部分。
// 真正开版本、挑选在引擎里（engine/groups.ts、pick.ts）。
import type { UpdateNodeBody, Variants } from '@oasis/contracts/task';
import { pad2 } from '../groups.ts';
import type { Node } from '../../repo/task-store.ts';
import type { Rates } from './kind.ts';

/** 方案里的做几版 → 配置（不写就没有） */
export const variantsConfig = (variants: Variants | undefined) =>
  variants && variants.n > 1 ? { variants } : {};

/** 库里的配置 → 方案（修改时沿用的节点照搬） */
export const variantsPlan = (node: Pick<Node, 'config'>) =>
  node.config.variants ? { variants: node.config.variants } : {};

/** 估价：一版的花费 × 版数，再加一次挑选（看图一次 + 一次沙箱） */
export function withVariants(one: number, variants: Variants | undefined, rates: Rates): number {
  if (!variants || variants.n < 2) return one;
  return one * variants.n + rates.tool('image.inspect') + rates.compute;
}

/** 用户改还没开始的节点：做几版（null 表示不做几版了） */
export function variantsEdit(body: UpdateNodeBody) {
  if (body.variants === undefined) return {};
  return { variants: body.variants ?? undefined };
}

/** 展开出来的一条、做几版里的一版：写进 AI 节点的说明 */
export function branchParts(node: Node, itemIndex: number | undefined): string[] {
  const parts: string[] = [];
  if (node.config.item !== undefined) {
    const item = JSON.stringify(node.config.item);
    parts.push(
      `【这一条】你负责清单里的第 ${pad2(itemIndex ?? 0)} 条（内容也在 in/_item.json）：${item.length > 2000 ? `${item.slice(0, 2000)}…` : item}`,
    );
  }
  const version = node.config.version;
  if (version)
    parts.push(
      `【多版】这是同一步的第 ${version.k} 版（共 ${version.n} 版），做完会和其他版比较后选一版：走你自己的方向，不要做成最保守的那种。`,
    );
  return parts;
}
