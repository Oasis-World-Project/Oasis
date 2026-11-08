// 修改（ADR 0022）：用户确认规划员排的修改方案后按方案改工作流再开跑；用户不改了就回到修改前的样子。
import { randomUUID } from 'node:crypto';
import type { PlanNode } from '@oasis/contracts/task';
import { childrenOf, isGroup, isRoot } from '../groups.ts';
import { nodeRow } from '../plan.ts';
import { toEdgeBody, toNodeBody } from './bodies.ts';
import type { Engine } from './shared.ts';

export function createRevisions(engine: Engine): Pick<Engine, 'applyRevision' | 'cancelRevision'> {
  const { logger } = engine.deps;
  return {
    /**
     * 先把当前工作流冻结成一版，再按方案改——沿用的原样留下，带 from 的保留原节点 ID（成果、同步路径、
     * 运行记录接得上），新节点新 ID，没出现的移出工作流；然后开跑。
     */
    async applyRevision(snapshot, w, fx) {
      const { task } = snapshot;
      const revision = task.revision!;
      const plan = revision.plan!;
      const all = [...snapshot.nodes];
      await w.addVersion({
        version: task.version,
        request: task.acceptance?.revision ?? null,
        nodes: all.map((n) => toNodeBody(n, all)),
        edges: snapshot.edges.map(toEdgeBody),
        deliverables: task.deliverables,
        spentMicro: all.reduce((sum, n) => sum + n.spentMicro, 0),
        createdAt: snapshot.versions.at(-1)?.frozenAt ?? task.createdAt,
      });
      // 用户在做几版的节点上改用了另一版（ADR 0026）：先换成那一版，下游再按方案重做
      if (revision.pick) {
        const picked = snapshot.nodes.find((n) => n.id === revision.pick!.nodeId);
        if (picked)
          await engine.useVersion(
            snapshot,
            w,
            picked,
            revision.pick.version,
            `你改用了第 ${revision.pick.version} 版`,
          );
      }
      // 方案只排工作流图里的节点；子节点跟着父节点（展开节点重新展开时指纹没变的沿用）
      const before = snapshot.nodes.filter(isRoot);
      const byKey = new Map(before.map((n) => [n.key, n]));
      const idOf = new Map<string, string>();
      for (const entry of plan.nodes) {
        if ('reuse' in entry) {
          const node = byKey.get(entry.reuse)!;
          idOf.set(entry.key, node.id);
          // 上一轮修改留下的修改意见、修复项不再带着（产出照旧交给下游）
          const { revision: _revision, repairChecks: _repairs, ...config } = node.config;
          await w.setNode(node.id, {
            status: 'succeeded',
            config,
            warning: null,
            finishedAt: node.finishedAt ?? new Date(),
          });
          continue;
        }
        const { from, mode, ...planNode } = entry;
        const source = from ? byKey.get(from) : undefined;
        const row = nodeRow(planNode as PlanNode, source?.id ?? randomUUID(), 'waiting');
        idOf.set(entry.key, row.id);
        if (!source) {
          await w.addNode(row);
          continue;
        }
        // 做几版的节点要重做：旧的各版移出，开跑时重新开
        if (source.kind !== 'foreach' && isGroup(source))
          for (const child of childrenOf(snapshot.nodes, source))
            await w.retireNode(child.id, revision.version);
        const outputsRunId = source.config.outputsRunId;
        await w.setNode(source.id, {
          key: row.key,
          title: row.title,
          role: row.role,
          goal: row.goal,
          model: row.model,
          // 接着改：接着上一版的会话，按意见和这次的安排改；重新做：新会话，上一版产出放进 in/_previous/
          config:
            mode === 'continue'
              ? {
                  ...row.config,
                  ...(outputsRunId ? { outputsRunId } : {}),
                  revision: revision.request,
                }
              : { ...row.config, ...(outputsRunId ? { previousRunId: outputsRunId } : {}) },
          status: 'waiting',
          attempts: 0,
          reworks: 0,
          userNotes: [],
          warning: null,
          spentMicro: 0,
          startedAt: null,
          finishedAt: null,
          ...(mode === 'continue' ? {} : { currentRunId: null, outputs: [], summary: null }),
        });
      }
      const kept = new Set(idOf.values());
      for (const edge of [...snapshot.edges]) await w.deleteEdge(edge.id);
      for (const node of before.filter((n) => !kept.has(n.id)))
        await w.retireNode(node.id, revision.version);
      for (const edge of plan.edges)
        await w.addEdge({
          id: randomUUID(),
          fromNodeId: idOf.get(edge.from)!,
          toNodeId: idOf.get(edge.to)!,
        });
      await w.setTask({
        version: revision.version,
        revision: null,
        // 直接给方案建的任务没有任务单：交付物照旧（「改用这一版」也能用在这种任务上，ADR 0026）
        deliverables: task.sheet
          ? task.sheet.deliverables.map((d) => ({
              name: d.name,
              form: d.form,
              nodeId: idOf.get(plan.deliverables[d.name] ?? '') ?? null,
            }))
          : task.deliverables,
        // 这一轮按修改意见验收（只查意见改好没有，ADR 0012）
        acceptance: { unmet: [], revision: revision.request },
        status: 'running',
        attention: null,
        finishedAt: null,
      });
      logger.info({ taskId: task.id, version: revision.version }, '用户确认了修改方案，开跑');
      await engine.schedule(snapshot, w, fx);
    },

    /** 用户不改了（规划中或待确认）：回到修改前的样子，成果不变 */
    async cancelRevision(snapshot, w, fx) {
      const { task } = snapshot;
      if (task.status === 'planning' && task.plannerRunId) fx.cancel.push(task.plannerRunId);
      await w.setTask({
        status: task.revision!.previousStatus,
        attention: null,
        revision: null,
        plannerRunId: null,
      });
      logger.info({ taskId: task.id }, '用户不改了');
    },
  };
}
