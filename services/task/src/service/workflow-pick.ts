// 「改用这一版」（ADR 0026）：做几版的节点挑好之后，用户可以换成另一版。
// - 下游还没开始：直接换（在展开里的一条换了，展开节点重新汇总），接着往下跑。
// - 下游已经做完（任务交付了）：排成一次修改——换版本、受影响的下游重新做（展开的下游指纹没变的条目沿用），
//   带预估等用户确认（和修改意见走同一个确认流程，ADR 0022）。
// - 下游正在跑：不能换，先等它跑完或停下。
import type { TaskBody } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { RevisionPlanNode, RevisionState } from '../repo/schema.ts';
import type { Snapshot } from '../repo/task-store.ts';
import { ACTIVE, toTaskBody, type Engine } from './engine/index.ts';
import { nodeOf } from './graph.ts';
import { childrenOf, hasVariants, isRoot, rootOf } from './groups.ts';
import { versionOf } from './pick.ts';
import { estimatePlan } from './planner.ts';
import { asPlanNode } from './revision-planner.ts';

const NOT_STARTED = ['draft', 'waiting', 'blocked'];
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

export function createPickApi(api: {
  engine: Engine;
  owned(ownerId: string, taskId: string): Promise<Snapshot>;
}) {
  const { engine, owned } = api;

  return {
    async pickVersion(
      ownerId: string,
      taskId: string,
      nodeId: string,
      version: number,
    ): Promise<TaskBody> {
      const { task: owner } = await owned(ownerId, taskId);
      // 可能要排成修改、算预估：单价事务外先取
      const pricing = await engine.planning.pricing(owner.payerId);
      await engine.transact(taskId, async (snapshot, w, fx) => {
        const { task } = snapshot;
        const node = nodeOf(snapshot, nodeId);
        if (!hasVariants(node) || node.status !== 'succeeded' || node.config.chosen === undefined)
          throw new HttpError(409, 'not_picked', `「${node.title}」还没挑好版本`);
        if (node.config.chosen === version)
          throw new HttpError(409, 'already_chosen', `已经在用第 ${version} 版了`);
        const child = childrenOf(snapshot.nodes, node).find(
          (c) => versionOf(c) === version && c.status === 'succeeded',
        );
        if (!child) throw new HttpError(404, 'version_not_found', `第 ${version} 版没有做成`);
        if (task.revision || ['planning', 'accepting'].includes(task.status))
          throw new HttpError(409, 'task_busy', '任务正在规划、验收或修改，等它结束后再换');
        const root = rootOf(snapshot.nodes, node);
        const downstream = [...engine.withDownstream(snapshot, [root])]
          .filter((id) => id !== root.id)
          .map((id) => nodeOf(snapshot, id));
        const reason = `你改用了第 ${version} 版`;
        if (downstream.every((n) => NOT_STARTED.includes(n.status))) {
          await engine.useVersion(snapshot, w, node, version, reason);
          await engine.schedule(snapshot, w, fx);
          return;
        }
        if (downstream.some((n) => ACTIVE.includes(n.status)))
          throw new HttpError(409, 'downstream_running', '下游正在用这一版，等它跑完或先停下再换');
        const affected = new Set(downstream.map((n) => n.id));
        const roots = snapshot.nodes.filter(isRoot);
        if (roots.some((r) => !affected.has(r.id) && r.status !== 'succeeded'))
          throw new HttpError(409, 'task_unfinished', '任务还有没做完的节点，先运行完再换');
        await w.setTask(proposal(snapshot, node.title, nodeId, version, affected, pricing));
      });
      return toTaskBody(await owned(ownerId, taskId));
    },
  };

  /** 下游已经做完：排成一次修改，等用户确认 */
  function proposal(
    snapshot: Snapshot,
    title: string,
    nodeId: string,
    version: number,
    affected: Set<string>,
    pricing: Awaited<ReturnType<Engine['planning']['pricing']>>,
  ) {
    const { task } = snapshot;
    const roots = snapshot.nodes.filter(isRoot);
    const keyOf = new Map(roots.map((n) => [n.id, n.key]));
    const redo = roots.filter((r) => affected.has(r.id));
    const estimate = estimatePlan(
      { nodes: redo.map(asPlanNode), edges: [] },
      pricing.models,
      pricing.tools,
      engine.deps.planning.fallback,
    ).totalMicro;
    const summary = `改用「${title}」的第 ${version} 版，受影响的 ${redo.length} 个下游节点重新做（展开出来的条目只重做用到这一版的），预计最多 ${usd(estimate)}`;
    const revision: RevisionState = {
      version: task.version + 1,
      request: `改用「${title}」的第 ${version} 版`,
      nodeIds: [nodeId],
      previousStatus: task.status,
      plan: {
        summary,
        nodes: roots.map((r): RevisionPlanNode =>
          affected.has(r.id)
            ? { ...asPlanNode(r), from: r.key, mode: 'fresh' }
            : { key: r.key, reuse: r.key },
        ),
        edges: snapshot.edges
          .filter((e) => e.fromNodeId && e.toNodeId)
          .map((e) => ({ from: keyOf.get(e.fromNodeId!)!, to: keyOf.get(e.toNodeId!)! })),
        deliverables: Object.fromEntries(
          task.deliverables.flatMap((d) =>
            d.nodeId && keyOf.has(d.nodeId) ? [[d.name, keyOf.get(d.nodeId)!]] : [],
          ),
        ),
      },
      estimateMicro: estimate,
      changes: roots.map((r) => ({
        key: r.key,
        title: r.title,
        change: affected.has(r.id) ? ('fresh' as const) : ('reuse' as const),
      })),
      pick: { nodeId, version },
    };
    return {
      revision,
      status: 'needs_attention' as const,
      attention: { reason: 'revision_plan' as const, nodeId, message: summary },
    };
  }
}
