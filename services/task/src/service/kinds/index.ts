// 节点种类登记表：引擎、规划门、编辑和估价都按节点的 kind 从这里取插件，不再自己分种类处理。
import type { NodeKind } from '../../repo/schema.ts';
import { discussion } from './discussion.ts';
import type { NodeKindPlugin } from './kind.ts';
import { tool } from './tool.ts';
import { work } from './work.ts';

const KINDS: { [K in NodeKind]: NodeKindPlugin<K> } = { work, discussion, tool };

/** 这个节点（库里的节点或方案里的节点）的插件；种类不确定的节点拿到的插件收各种节点 */
export function kindOf<K extends NodeKind>(node: { kind: K }): NodeKindPlugin<K> {
  return KINDS[node.kind];
}

export { inputsOf, isOpen, openRuns, reworkStep } from './common.ts';
export type { Rates, Step } from './kind.ts';
