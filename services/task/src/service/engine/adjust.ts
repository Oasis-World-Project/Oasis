// 中途调整落到工作流上：规划员同意的改动在事务里改——停掉成果、补说明、加成果。
// 加了、停了成果时先把改之前的样子冻结成一版，工作流页能回看；改动记在节点上，给用户看调整过什么。
import { randomUUID } from 'node:crypto';
import { adjustNote } from '../adjust.ts';
import { childrenOf, isRoot } from '../groups.ts';
import { openRuns } from '../kinds/index.ts';
import { nodeRow } from '../plan.ts';
import { toEdgeBody, toNodeBody } from './bodies.ts';
import { FINAL, type Engine } from './shared.ts';

export function createAdjust(engine: Engine): Pick<Engine, 'applyAdjust'> {
  return {
    async applyAdjust(snapshot, w, fx, a, deliver) {
      const { task } = snapshot;
      const structural = a.added.nodes.length > 0 || a.stopped.length > 0;
      if (structural) {
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
      }
      for (const node of a.stopped) {
        fx.abortChecks.push({ taskId: task.id, nodeId: node.id });
        // 连同它开出的子节点（展开出来的条目、各版）
        for (const one of [node, ...childrenOf(snapshot.nodes, node)]) {
          if (FINAL.includes(one.status)) continue;
          await engine.endRuns(w, openRuns(snapshot, one.id), 'cancel', fx);
          await w.setNode(one.id, {
            status: 'cancelled',
            finishedAt: new Date(),
            ...(one === node
              ? { config: { ...one.config, adjust: adjustNote(`停掉了：${a.reply}`) } }
              : {}),
          });
        }
      }
      for (const { node, text } of a.instructed) {
        // 正在做的直接送进它的会话；还没开始、停下的记下来，开跑或继续时带上
        const live = node.status === 'running' && node.currentRunId;
        if (live) deliver.push({ runId: live, text: `规划员给你这样成果补了说明：\n${text}` });
        await w.setNode(node.id, {
          ...(live ? {} : { userNotes: [...node.userNotes, `（规划员中途调整）${text}`] }),
          config: { ...node.config, adjust: adjustNote(`说明改了：${text}`) },
        });
      }
      const idOf = new Map(snapshot.nodes.filter(isRoot).map((n) => [n.key, n.id]));
      for (const planNode of a.added.nodes) {
        const row = nodeRow(planNode, randomUUID());
        idOf.set(row.key, row.id);
        await w.addNode({
          ...row,
          config: { ...row.config, adjust: adjustNote(`中途新加的：${a.reply}`) },
        });
      }
      for (const edge of a.added.edges)
        await w.addEdge({
          id: randomUUID(),
          fromNodeId: idOf.get(edge.from)!,
          toNodeId: idOf.get(edge.to)!,
        });
      await w.setTask({
        ...(structural ? { version: task.version + 1 } : {}),
        deliverables: task.deliverables.map((d) => {
          const key = a.deliverables[d.name];
          return key ? { ...d, nodeId: idOf.get(key) ?? d.nodeId } : d;
        }),
      });
      await engine.schedule(snapshot, w, fx);
    },
  };
}
