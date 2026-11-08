// 工具节点（ADR 0025）：不起 AI，在沙箱里按顺序执行写好的工具步骤——外部工具交给 oasis-tool，本地操作
// （op.*，拼视频、转格式……）交给 oasis-op。harness 的工具运行里每步失败自动重试 2 次，还不行节点失败、
// 交给用户处理（和干活节点一样）。
// - 开跑：一次工具运行，带上上游交来的文件；做完照常过关卡，关卡只提醒、不返工（没有 AI 能改）。
// - 停止后继续、失败后再试：接着原运行的工作目录，做完的步骤不重做，做到一半的长任务接着原来的提交。
// - 估价：每步按工具单价 × 计费单位数（视频的秒数、生图的张数），加一次沙箱算力。
import { TOOL_RUN_MODEL } from '@oasis/contracts/harness';
import { checkToolArgs, listOf } from '@oasis/contracts/tool-args';
import type { ToolStep } from '@oasis/contracts/tool-step';
import { HttpError } from '@oasis/service-kit';
import type { ToolConfig } from '../../repo/schema.ts';
import type { NodeOf, Snapshot } from '../../repo/task-store.ts';
import { inputsOf, redoOf } from './common.ts';
import type { NodeKindPlugin, Step } from './kind.ts';
import { variantsConfig, variantsEdit, variantsPlan, withVariants } from './variants.ts';

type ToolNode = NodeOf<'tool'>;

/** 上游交来的文件：in/<上游节点>/<文件> */
const UPSTREAM_FILE = /^in\/([^/]+)\/(.+)$/;
const SANDBOX_PREFIX = /^(?:in|materials|out)\//;

/** 参数里写的沙箱文件：单个路径、路径数组、JSON 数组或逗号分隔的路径（不看工具目录也认得出） */
function filesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(filesIn);
  if (typeof value !== 'string') return [];
  const items = value.trim().startsWith('[') ? listOf(value) : undefined;
  if (items) return items.flatMap(filesIn);
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => SANDBOX_PREFIX.test(p))) return parts;
  return SANDBOX_PREFIX.test(value) ? [value] : [];
}

/** 步骤直接引用的上游文件：规划门要求有连线，并让上游必须交出它们 */
export function upstreamFiles(steps: ToolStep[]): { from: string; path: string }[] {
  const found = new Map<string, { from: string; path: string }>();
  for (const step of steps)
    for (const file of Object.values(step.args).flatMap(filesIn)) {
      const match = UPSTREAM_FILE.exec(file);
      if (match) found.set(file, { from: match[1]!, path: match[2]! });
    }
  return [...found.values()];
}

/** 一步的计费单位数：目录说按哪个参数计（视频的秒数、生图的张数）就按它，否则一次一个单位 */
export function unitsOf(step: ToolStep, per: { arg: string; default: number } | undefined) {
  if (!per) return 1;
  const value = Number(step.args[per.arg]);
  return Number.isFinite(value) && value > 0 ? value : per.default;
}

const modelOf = (step: ToolStep) =>
  typeof step.args.model === 'string' && step.args.model ? step.args.model : undefined;

/** 结果路径不能和别的步骤撞上，免得后一步盖掉前一步的结果 */
function stepProblems(key: string, steps: ToolStep[]): string[] {
  const outs = steps.map((s) => s.out).filter((o): o is string => Boolean(o));
  const repeated = [...new Set(outs.filter((o, i) => outs.indexOf(o) !== i))];
  return repeated.map((o) => `工具节点「${key}」有几步的结果都存到 ${o}，会互相覆盖`);
}

/** 开跑：一次工具运行（prompt 只用来记录） */
function request(node: ToolNode, continueFrom?: string): Step['requests'][number] {
  return {
    purpose: 'work',
    model: TOOL_RUN_MODEL,
    prompt: `工具节点「${node.title}」：${node.goal}`,
    inputsFrom: [],
    ...(continueFrom ? { continueFrom } : {}),
    steps: node.config.steps ?? [],
    meta: {},
  };
}

function start(snapshot: Snapshot, node: ToolNode): Step {
  return { requests: [{ ...request(node), inputsFrom: inputsOf(snapshot, node) }] };
}

/** 接着节点当前那次运行的工作目录做完：做完的步骤不重做 */
function carryOn(snapshot: Snapshot, node: ToolNode): Step {
  if (!node.currentRunId) return start(snapshot, node);
  return { requests: [request(node, node.currentRunId)] };
}

export const tool: NodeKindPlugin<'tool'> = {
  problems: (plan) => stepProblems(plan.key, plan.steps),
  inputFiles: (plan) => upstreamFiles(plan.steps),
  models: () => [],
  toolProblems(plan, tools) {
    const problems: string[] = [];
    for (const [index, step] of plan.steps.entries()) {
      const where = `工具节点「${plan.key}」第 ${index + 1} 步`;
      const entry = tools.get(step.tool);
      if (!entry) {
        problems.push(`${where}的工具 ${step.tool} 不在可以用的工具里`);
        continue;
      }
      problems.push(
        ...checkToolArgs(entry.args, step.args).map((p) => `${where}（${step.tool}）${p}`),
      );
      const model = modelOf(step);
      if (model && entry.models.length && !entry.models.includes(model))
        problems.push(
          `${where}的 ${step.tool} 不能用型号 ${model}，可选：${entry.models.join('、')}`,
        );
      // 批量生成文字在 AI 节点里默认用节点的模型；工具节点没有模型，要写明
      if (step.tool === 'text.batch' && !model)
        problems.push(`${where}的 text.batch 要写 model（工具节点没有默认模型）`);
    }
    return problems;
  },
  estimate: (plan, rates) =>
    withVariants(
      rates.compute +
        plan.steps.reduce(
          (sum, step) =>
            sum +
            unitsOf(step, rates.per(step.tool)) * rates.tool(step.tool, modelOf(step), step.args),
          0,
        ),
      plan.variants,
      rates,
    ),
  config: (plan): ToolConfig => ({ steps: plan.steps, ...variantsConfig(plan.variants) }),
  plan: (node, common) => ({
    ...common,
    kind: 'tool',
    steps: node.config.steps ?? [],
    ...variantsPlan(node),
  }),
  edit(node, body) {
    if (body.participants !== undefined || body.rounds !== undefined)
      throw new HttpError(400, 'invalid_node', '只有讨论节点有参与者和轮数');
    if (body.tools !== undefined)
      throw new HttpError(400, 'invalid_node', '工具节点用的工具写在步骤里');
    if (!body.steps) return variantsEdit(body);
    const problems = stepProblems(node.key, body.steps);
    if (problems.length) throw new HttpError(400, 'invalid_node', problems.join('；'));
    return { steps: body.steps, ...variantsEdit(body) };
  },
  body(node) {
    const steps = node.config.steps ?? [];
    // 工作流页和修改规划员照常看「用了哪些工具」：按步骤数
    const uses = new Map<string, number>();
    for (const step of steps) uses.set(step.tool, (uses.get(step.tool) ?? 0) + 1);
    return {
      tools: [...uses].map(([key, count]) => ({ key, uses: count })),
      discussion: null,
      steps,
    };
  },
  // 没有会话可以接着改：修改时只能沿用或重新跑
  continuable: false,
  reworkable: false,
  switchable: false,
  listens: false,

  start,
  resume(snapshot, node, last) {
    // 停下前那次运行已经交出产出：不用再跑，直接重新过关卡
    if (last?.status === 'succeeded' && node.config.outputsRunId === last.id) return 'gate';
    return carryOn(snapshot, node);
  },
  retry: (snapshot, node, failed) =>
    // 原运行的工作目录还在就接着做，做完的步骤（已经付过钱的）不重做
    failed.meta.resumable
      ? carryOn(snapshot, { ...node, currentRunId: failed.id })
      : start(snapshot, node),
  redo: (snapshot, node, run) => redoOf(node, run, start(snapshot, node).requests[0]!),
  current: (node, run) => node.currentRunId === run.id,
  succeeded: () => ({ deliver: true }),
  // 不会用到（switchable 为 false）：工具节点不用模型
  switchModel: (node) => ({ config: node.config }),
  live: false,
};
