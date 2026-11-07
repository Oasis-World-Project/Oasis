// 干活节点：一个 agent 在持续目标里做完一件事（ADR 0004、0015）。
// - 开跑：持续目标，带上下文、工具和预算；交出产出后过关卡。
// - 停止后继续：接着停下的那次运行的会话；那次运行已经交出产出、又没有新要求时直接重新过关卡。
// - 失败：原会话的工作目录还在就接着做，不把已付费的工作从头重放；否则从头做。
// - 运行中花费越过份额的 1.5 倍、2 倍时各提醒一次收尾（节点在会话里看不到花费）。
import { HttpError } from '@oasis/service-kit';
import type { WorkConfig } from '../../repo/schema.ts';
import type { NodeOf, NodeRun, Snapshot } from '../../repo/task-store.ts';
import { contextParts, NO_QUESTIONS, resumePrompt, type NodeContext } from '../prompt.ts';
import { contextOf, inputsOf, redoOf } from './common.ts';
import type { NodeKindPlugin, Step } from './kind.ts';

type WorkNode = NodeOf<'work'>;

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** 节点花费到份额的这些倍数时各提醒一次收尾（用户 2026-11-07 同意 1.5 倍、2 倍） */
const NUDGE_AT = [1.5, 2];

/** 预算和进度：只给事实，节点自己掂量 */
function budgetPart(b: NonNullable<NodeContext['budget']>): string {
  const facts = [
    ...(b.nodeMicro ? [`这一步分到约 ${usd(b.nodeMicro)}`] : []),
    ...(b.taskMicro
      ? [`整个任务预算约 ${usd(b.taskMicro)}，已花 ${usd(b.spentMicro)}`]
      : [`整个任务已花 ${usd(b.spentMicro)}`]),
    `已经跑了 ${b.elapsedMinutes} 分钟${b.taskMinutes ? `，预计总用时约 ${b.taskMinutes} 分钟` : ''}`,
  ];
  return `【预算和用时】${facts.join('；')}。预算是参考不是上限，但花的是用户的钱、用户也在等：够用就交。`;
}

/** 节点能用的外部工具：都通过沙箱里的 oasis-tool 命令调用，用法让 AI 自己查 */
function toolsPart(tools: string[]): string {
  return [
    '【工具】',
    ...(tools.length ? [`- 规划建议用：${tools.join('、')}（不限于这些）。`] : []),
    '- `oasis-tool list` 列出全部工具、用法和单价；长任务没等到就按提示 `oasis-tool wait <任务号>`。',
    '- 交互网页、3D 预览等的文件格式见 in/.oasis-formats.json。沙箱里没有浏览器，网页用 `oasis-tool app.check --dir out/<应用目录>` 在独立浏览器里跑。',
  ].join('\n');
}

/** 干活节点的说明（tools：分给它的外部工具名） */
function workPrompt(c: NodeContext, tools: string[]): string {
  return [
    `你是 Oasis 工作流里的一个节点，负责「${c.title}」。`,
    ...contextParts(c, '你要做的事'),
    ...(c.budget ? [budgetPart(c.budget)] : []),
    toolsPart(tools),
    [
      '【说明】',
      '- 成果写到 out/（可建子目录），下游和用户只看得到 out/。',
      '- 这是持续目标：要交的文件都做好了就 update_goal complete 结束。',
      NO_QUESTIONS,
      '- 最后用一两句话说明交付了什么。',
    ].join('\n'),
  ].join('\n\n');
}

function start(snapshot: Snapshot, node: WorkNode): Step {
  return {
    requests: [
      {
        purpose: 'work',
        goal: true,
        model: node.model,
        prompt: workPrompt(
          contextOf(snapshot, node),
          (node.config.tools ?? []).map((t) => t.key),
        ),
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
  models: (plan) => [plan.model],
  toolProblems(plan, tools) {
    const problems: string[] = [];
    for (const tool of plan.tools) {
      const entry = tools.get(tool.key);
      if (!entry) {
        problems.push(`节点「${plan.key}」的工具 ${tool.key} 不在可以用的工具里`);
      } else if (tool.model && entry.models.length && !entry.models.includes(tool.model)) {
        problems.push(
          `节点「${plan.key}」的工具 ${tool.key} 不能用型号 ${tool.model}，可选：${entry.models.join('、')}`,
        );
      }
    }
    return problems;
  },
  estimate: (plan, rates) =>
    rates.node(plan.model) +
    rates.compute +
    plan.tools.reduce((sum, t) => sum + t.uses * rates.tool(t.key, t.model), 0),
  config: (plan): WorkConfig => ({ tools: plan.tools }),
  plan: (node, common) => ({ ...common, kind: 'work', tools: node.config.tools ?? [] }),
  edit(_node, body) {
    if (body.participants !== undefined || body.rounds !== undefined)
      throw new HttpError(400, 'invalid_node', '只有讨论节点有参与者和轮数');
    return body.tools ? { tools: body.tools } : {};
  },
  body: (node) => ({ tools: node.config.tools ?? [], discussion: null }),
  continuable: true,

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
  nudge(node, spentMicro, now = new Date()) {
    const share = node.config.budgetMicro;
    if (node.status !== 'running' || !node.currentRunId || !share) return;
    const sent = node.config.budgetNudges ?? 0;
    const crossed = NUDGE_AT.filter((times) => spentMicro >= share * times).length;
    if (crossed <= sent) return;
    const minutes = node.startedAt
      ? Math.max(0, Math.round((now.getTime() - node.startedAt.getTime()) / 60_000))
      : undefined;
    return {
      config: { ...node.config, budgetNudges: crossed },
      text: `【系统提醒】这一步已花 ${usd(spentMicro)}（分到约 ${usd(share)}）${minutes === undefined ? '' : `，已经跑了 ${minutes} 分钟`}。请收尾：把现有成果整理好交出来，别再打磨。`,
    };
  },
};
