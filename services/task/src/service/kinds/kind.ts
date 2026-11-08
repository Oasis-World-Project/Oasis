// 节点种类插件的接口（重构方案阶段 2）：工作流引擎只通过这组接口和节点打交道，不认识具体种类。
// 加一种节点：schema.ts 的 KindConfigs 加一行配置类型，写一个实现 NodeKindPlugin 的模块，在 kinds/index.ts 登记。
import type { RunInputFile } from '@oasis/contracts/harness';
import type { NodeBody, PlanNode, UpdateNodeBody } from '@oasis/contracts/task';
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import type { ToolStep } from '@oasis/contracts/tool-step';
import type { KindConfigs, NodeKind, NodeRunPurpose, RunMeta } from '../../repo/schema.ts';
import type { NodeOf, NodeRun, Snapshot } from '../../repo/task-store.ts';

/** 要开的一次运行 */
export interface RunRequest {
  goal?: boolean;
  purpose: NodeRunPurpose;
  model: string;
  prompt: string;
  inputsFrom: { runId: string; as: string }[];
  /**
   * 直接放进 in/ 的小文件；不写时开新会话（或换了上游产出）的运行由引擎补上展开节点的清单索引、
   * 这一条的内容（ADR 0026）
   */
  inputs?: RunInputFile[];
  /** 接着哪次运行的会话和工作区 */
  continueFrom?: string;
  /** 工具运行（ADR 0025）：不起 AI，按顺序执行这些步骤 */
  steps?: ToolStep[];
  meta: RunMeta;
}

/** 节点的一步：要开的运行，以及开这些运行时节点配置要跟着改的地方（讨论的轮次、已交出去的追加要求） */
export interface Step<C = KindConfigs[NodeKind]> {
  requests: RunRequest[];
  config?: C;
}

/** 一次运行成功结束之后：交出了产出就去过关卡；这一步还没完就记下（如讨论的发言），需要时开下一步 */
type Outcome<C> = { deliver: true } | { deliver: false; config: C; next?: Step<C> };

/** 方案里的某种节点 */
type PlanOf<K extends NodeKind> = Extract<PlanNode, { kind: K }>;

/** 方案节点里各种节点都有的字段（对联合类型 Omit 只留共有的键；种类特有的由插件补上） */
type CommonPlan = Omit<PlanNode, 'kind'>;

/** 估价用的单价（微美元，ADR 0016 §4） */
export interface Rates {
  /** 这个型号干一次活的典型花费 */
  node(model: string): number;
  /** 一次工具调用（按所选型号；给了参数时单价随参数变的按参数取，如视频的清晰度） */
  tool(key: string, model?: string, args?: Record<string, unknown>): number;
  /** 工具的计费单位数写在哪个参数里（视频的秒数、生图的张数）；没有就按一次一个单位 */
  per(key: string): { arg: string; default: number } | undefined;
  /** 一次发言 */
  speech: number;
  /** 一次运行的沙箱算力 */
  compute: number;
}

/**
 * 一种节点。方法都用简写（参数双向检查）：引擎拿到的是 NodeKindPlugin<NodeKind>，按节点的 kind 取对应插件，
 * 所以每个插件只会收到自己种类的节点。
 */
export interface NodeKindPlugin<K extends NodeKind> {
  // ---- 方案、编辑、展示、估价（规划门、用户编辑节点、工作流页、报价）

  /** 方案节点自身的问题（如讨论里参与者重名）；没有返回空数组 */
  problems(plan: PlanOf<K>): string[];
  /** 节点直接引用的上游文件（工具节点参数里写的 in/<上游>/…）：规划门要求有连线，并让上游必须交出它们 */
  inputFiles?(plan: PlanOf<K>): { from: string; path: string }[];
  /** 用到的型号（规划门核对模型目录） */
  models(plan: PlanOf<K>): string[];
  /** 用到的工具不在目录里、型号不可选的问题 */
  toolProblems(plan: PlanOf<K>, tools: ReadonlyMap<string, ToolEntry>): string[];
  /** 估价 */
  estimate(plan: PlanOf<K>, rates: Rates): number;
  /** 方案节点 → 这种节点自己的配置（各种节点都有的部分由 plan.ts 填） */
  config(plan: PlanOf<K>): KindConfigs[K];
  /** 库里的节点 → 方案节点（修改时沿用的节点照搬给规划门和估价） */
  plan(node: NodeOf<K>, common: CommonPlan): PlanOf<K>;
  /** 用户改还没开始的节点：这种节点自己的配置项；不属于它的项抛 400 */
  edit(node: NodeOf<K>, body: UpdateNodeBody): Partial<KindConfigs[K]>;
  /** 给工作流页看的、这种节点特有的部分 */
  body(node: NodeOf<K>): Pick<NodeBody, 'tools' | 'discussion' | 'steps'>;
  /** 修改时能接着上一版的会话改（ADR 0022 的「接着改」） */
  readonly continuable: boolean;
  /**
   * 关卡没过、整体验收缺文件、用户的修改意见时能接着原会话让 AI 改（没有 AI 的工具节点不能，
   * 要改只能重新跑一遍）
   */
  readonly reworkable: boolean;
  /** 用的模型在当前网络用不了时换默认模型接着做（工具节点不用模型） */
  readonly switchable: boolean;
  /** 收用户的追问和补充要求（工具节点没有 AI，不收） */
  readonly listens: boolean;

  // ---- 运行

  /** 开跑：第一次跑，或从头再做 */
  start(snapshot: Snapshot, node: NodeOf<K>): Step;
  /** 停止后继续（last：停下前最后一次运行）；返回 'gate' 表示那次运行已经交出产出，直接重新过关卡 */
  resume(snapshot: Snapshot, node: NodeOf<K>, last?: NodeRun): Step | 'gate';
  /** 失败后重做同一步 */
  retry(snapshot: Snapshot, node: NodeOf<K>, failed: NodeRun): Step;
  /** 接不上原会话（持久工作目录不在了）：重新开会话做这一步（ADR 0022 的「重新做」） */
  redo(snapshot: Snapshot, node: NodeOf<K>, run: NodeRun): Step;
  /** 这次运行还是不是节点当前这一步（过期的运行结束了也不推进） */
  current(node: NodeOf<K>, run: NodeRun): boolean;
  /** 一次运行成功结束（text：它最后说的话） */
  succeeded(
    snapshot: Snapshot,
    node: NodeOf<K>,
    run: NodeRun,
    text: string | null,
  ): Outcome<KindConfigs[K]>;
  /** 这次运行用的模型在当前网络用不了，改用 model：返回节点要改的地方 */
  switchModel(
    node: NodeOf<K>,
    run: NodeRun,
    model: string,
  ): { model: string } | { config: KindConfigs[K] };
  /** 运行中用户的追问能直接插进会话；不能的（讨论）先记下，下一步带上 */
  readonly live: boolean;
  /** 运行中花费越过提醒线时要发给节点的话（只对看不到花费的长会话有用；没有就不提醒） */
  nudge?(
    node: NodeOf<K>,
    spentMicro: number,
    now?: Date,
  ): { text: string; config: KindConfigs[K] } | undefined;
}
