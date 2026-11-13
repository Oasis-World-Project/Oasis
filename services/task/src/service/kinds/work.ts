// 干活节点：一个 AI 在一次持续会话里把一样成果从头做到交付（ADR 0004、0015、0030）。
// - 开跑：持续目标，带上任务、任务单、要交什么、能用的文件和工具；步骤和校验它自己定，交出产出后过关卡。
// - 停止后继续：接着停下的那次运行的会话；那次运行已经交出产出、又没有新要求时直接重新过关卡。
// - 失败：原会话的工作目录还在就接着做，不把已付费的工作从头重放；否则从头做。
// - 没有预算、用时上限和提醒：它自己结束、用户停止、模型连不上、余额用完才会停。
import type { NodeOf, NodeRun, Snapshot } from '../../repo/task-store.ts';
import { contextParts, NO_QUESTIONS, resumePrompt, type NodeContext } from '../prompt.ts';
import { contextOf, inputsOf, redoOf } from './common.ts';
import type { NodeKindPlugin, Step } from './kind.ts';
import { branchParts, variantsConfig, variantsPlan } from './variants.ts';

type WorkNode = NodeOf<'work'>;

/** 沙箱里有什么、外部工具怎么用：都让 AI 自己查 */
const TOOLS_PART = [
  '【工具】',
  '- `oasis-tool list` 列出全部外部工具、用法和单价，以及沙箱里预装的软件和 Python、Node 包；长任务没等到就按提示 `oasis-tool wait <任务号>`。',
  '- 沙箱里有什么（浏览器、命令行工具）见 in/.oasis-environment.json；交互网页、3D 预览等的文件格式见 in/.oasis-formats.json。',
  '- `oasis-tool app.check --dir out/<应用目录>` 按画布的方式打开网页跑一遍，交付后的检查用的是同一套。',
].join('\n');

/** 只告诉从头做到交付一样成果的 AI：要动别的成果时怎么向规划员提（ADR 0030 §3.7） */
const ADJUST_PART =
  '- 要动别的成果才做得好时（缺一样成果、别的成果的说明要改、有一样成果不用做了），`oasis-tool workflow.adjust --want "要调整什么" --why "为什么"` 向规划员提一次；没等到答复就接着做自己的，过后按提示 `oasis-tool wait <任务号>` 取。自己这样成果里怎么做不用提。';

/** 干活节点的说明（branch：展开出来的一条、做几版里的一版） */
function workPrompt(c: NodeContext, branch: string[] = []): string {
  return [
    `你是 Oasis 里负责「${c.title}」的 AI。`,
    ...contextParts(c, '你要做的事'),
    ...branch,
    branch.length ? TOOLS_PART : `${TOOLS_PART}\n${ADJUST_PART}`,
    [
      '【说明】',
      '- 成果写到 out/（可建子目录），下游和用户只看得到 out/。',
      '- 这是持续目标：怎么做、分几步、怎么校验由你定；要交的文件都做好了就 update_goal complete 结束。',
      '- 你用 todo_write 列的任务清单会显示给用户看进度。',
      NO_QUESTIONS,
      '- 最后用一两句话说明交付了什么。',
    ].join('\n'),
  ].join('\n\n');
}

/** 展开出来的一条排第几（某一版的节点看它的父节点） */
function itemIndex(snapshot: Snapshot, node: WorkNode): number | undefined {
  if (node.config.item === undefined) return undefined;
  const owner = node.config.version ? snapshot.nodes.find((n) => n.id === node.parentId) : node;
  return owner?.slot ?? undefined;
}

function start(snapshot: Snapshot, node: WorkNode): Step {
  return {
    requests: [
      {
        purpose: 'work',
        goal: true,
        model: node.model,
        prompt: workPrompt(contextOf(snapshot, node), branchParts(node, itemIndex(snapshot, node))),
        inputsFrom: inputsOf(snapshot, node),
        meta: {},
      },
    ],
    config: { ...node.config, notesSeen: node.userNotes.length },
  };
}

/** 接着节点当前那次运行的会话做完；interrupted：上次是中断（不是用户停下的） */
function carryOn(snapshot: Snapshot, node: WorkNode, interrupted: boolean): Step {
  // 还没真正跑起来就停了（没有运行）：从头做
  if (!node.currentRunId) return start(snapshot, node);
  return {
    requests: [
      {
        purpose: 'work',
        goal: true,
        model: node.model,
        prompt: resumePrompt(node.userNotes.slice(node.config.notesSeen ?? 0), interrupted),
        inputsFrom: [],
        continueFrom: node.currentRunId,
        meta: {},
      },
    ],
    config: { ...node.config, notesSeen: node.userNotes.length },
  };
}

export const work: NodeKindPlugin<'work'> = {
  problems: () => [],
  texts: (plan) => [plan.goal, plan.role],
  models: (plan) => [plan.model],
  toolProblems: () => [],
  config: (plan) => variantsConfig(plan.variants),
  plan: (node, common) => ({ ...common, kind: 'work', ...variantsPlan(node) }),
  body: () => ({ discussion: null, steps: null }),
  continuable: true,
  reworkable: true,
  switchable: true,
  listens: true,

  start,
  resume(snapshot, node, last) {
    // 停下前那次运行已经交出产出、之后也没有新要求：不用再跑，直接重新过关卡
    if (
      last?.status === 'succeeded' &&
      node.config.outputsRunId === last.id &&
      (node.config.notesSeen ?? 0) === node.userNotes.length
    )
      return 'gate';
    return carryOn(snapshot, node, false);
  },
  retry: (snapshot, node, failed: NodeRun) =>
    // 原会话的工作目录还在就接着做，不把已付费的工作从头重放
    failed.meta.resumable
      ? carryOn(snapshot, { ...node, currentRunId: failed.id }, true)
      : start(snapshot, node),
  redo: (snapshot, node, run) => redoOf(node, run, start(snapshot, node).requests[0]!),
  current: (node, run) => node.currentRunId === run.id,
  succeeded: () => ({ deliver: true }),
  switchModel: (_node, _run, model) => ({ model }),
  live: true,
};
