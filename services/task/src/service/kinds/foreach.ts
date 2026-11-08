// 展开节点（ADR 0026）：上游交出一份 JSON 清单，有几条就开几个子节点（each 是每条的做法：干活或工具），
// 同时跑；都做完后产出按条目号放进 NN/，下游拿到 in/<key>/01/…、02/… 和 in/<key>/index.json。
// 它自己不跑（引擎按组节点处理，engine/groups.ts、expand.ts），这里只管方案、估价和展示。
// - 规划门：做法本身按它的种类查；参数里带 {{…}} 模板的等展开时再查（缺参数也等那时）。
// - 估价：预计条数 × 每条（每条做几版的已经乘进去）。
import type { ToolEntry } from '@oasis/contracts/model-gateway';
import type { ForeachBranch, PlanNode } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { ForeachConfig } from '../../repo/schema.ts';
import { hasTemplate } from '../groups.ts';
import type { NodeKindPlugin } from './kind.ts';
import { tool } from './tool.ts';
import { work } from './work.ts';

type ForeachPlan = Extract<PlanNode, { kind: 'foreach' }>;
type BranchPlan = Extract<PlanNode, { kind: 'work' | 'tool' }>;

/** 每条的做法 → 一个方案节点（规划门和估价按它的种类查） */
const branchPlan = (plan: { key: string; title: string; each: ForeachBranch }): BranchPlan =>
  ({ ...plan.each, key: plan.key, title: plan.each.title ?? plan.title }) as BranchPlan;

/** 清单从哪个上游来：over 写成 in/<上游 key>/<文件> */
export function listSource(over: string): { from: string; path: string } {
  const [, from = '', ...rest] = over.split('/');
  return { from, path: rest.join('/') };
}

/** 带模板的参数先拿掉再查，缺它们的问题等展开时再说 */
function toolProblems(plan: ForeachPlan, tools: ReadonlyMap<string, ToolEntry>): string[] {
  const branch = branchPlan(plan);
  if (branch.kind !== 'tool') return work.toolProblems(branch, tools);
  const templated = new Set<string>();
  const steps = branch.steps.map((step) => ({
    ...step,
    args: Object.fromEntries(
      Object.entries(step.args).filter(([name, value]) => {
        if (!hasTemplate(value)) return true;
        templated.add(name);
        return false;
      }),
    ),
  }));
  return tool
    .toolProblems({ ...branch, steps }, tools)
    .filter((p) => ![...templated].some((name) => p.includes(name)));
}

export const foreach: NodeKindPlugin<'foreach'> = {
  problems(plan) {
    const branch = branchPlan(plan);
    return branch.kind === 'tool' ? tool.problems(branch) : work.problems(branch);
  },
  inputFiles(plan) {
    const branch = branchPlan(plan);
    const used = branch.kind === 'tool' ? (tool.inputFiles?.(branch) ?? []) : [];
    return [listSource(plan.over), ...used];
  },
  models: (plan) => {
    const branch = branchPlan(plan);
    return branch.kind === 'work' ? work.models(branch) : [];
  },
  toolProblems,
  estimate(plan, rates) {
    const branch = branchPlan(plan);
    const each =
      branch.kind === 'tool' ? tool.estimate(branch, rates) : work.estimate(branch, rates);
    return plan.count * each;
  },
  config: (plan): ForeachConfig => ({ over: plan.over, count: plan.count, each: plan.each }),
  plan: (node, common) => ({
    ...common,
    kind: 'foreach',
    over: node.config.over ?? '',
    count: node.config.count ?? 1,
    each: node.config.each!,
  }),
  edit(_node, body) {
    if (
      body.participants !== undefined ||
      body.rounds !== undefined ||
      body.tools !== undefined ||
      body.steps !== undefined ||
      body.variants !== undefined
    )
      throw new HttpError(400, 'invalid_node', '展开节点每条怎么做写在做法里，要改请提修改意见');
    return {};
  },
  body: () => ({ tools: [], discussion: null, steps: null }),
  continuable: false,
  reworkable: false,
  switchable: false,
  listens: false,

  // 下面这些不会用到：展开节点自己不跑，由引擎按组节点处理
  start: () => ({ requests: [] }),
  resume: () => ({ requests: [] }),
  retry: () => ({ requests: [] }),
  redo: () => ({ requests: [] }),
  current: () => false,
  succeeded: () => ({ deliver: true }),
  switchModel: (node) => ({ config: node.config }),
  live: false,
};
