// 节点种类登记表：引擎、规划门、编辑和估价都按节点的 kind 从这里取插件，不再自己分种类处理。
import type { NodeKind } from '../../repo/schema.ts';
import { discussion } from './discussion.ts';
import { foreach } from './foreach.ts';
import type { NodeKindPlugin } from './kind.ts';
import { tool } from './tool.ts';
import { work } from './work.ts';

const KINDS: { [K in NodeKind]: NodeKindPlugin<K> } = { work, discussion, tool, foreach };

/** 这个节点（库里的节点或方案里的节点）的插件；种类不确定的节点拿到的插件收各种节点 */
export function kindOf<K extends NodeKind>(node: { kind: K }): NodeKindPlugin<K> {
  return KINDS[node.kind];
}

export {
  inlineInputsOf,
  inputsOf,
  isOpen,
  openRuns,
  refsOf,
  reworkStep,
  upstreamOf,
} from './common.ts';
export { listSource } from './foreach.ts';
export type { Rates, RunRequest, Step } from './kind.ts';
