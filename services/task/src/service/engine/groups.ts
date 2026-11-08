// 组节点（ADR 0026）：展开节点、做几版的节点自己不跑，开子节点去做。
// - 开跑：展开节点先去读清单（事务外，见 expand.ts）；做几版的节点开出 n 个版本子节点。停下、失败过的子节点重新排队。
// - 每次调度前看一眼：展开的每一条都做完了就汇总成展开节点的产出（NN/…）；各版都结束了就挑一版——
//   只剩一版做成就用它，都没做成就失败交给用户，两版以上开一次挑选运行（pick.ts）。
// - 挑选结束：按结果用那一版；挑选失败或结果不可用先用做成的第一版，原因写进提醒。落选的版本留着，用户可以改用。
import { randomUUID } from 'node:crypto';
import { TOOL_RUN_MODEL } from '@oasis/contracts/harness';
import type { Node, Writer } from '../../repo/task-store.ts';
import { childrenOf, depthOf, freeKey, isGroup, pad2 } from '../groups.ts';
import { parsePick, pickRequest, versionOf } from '../pick.ts';
import { poolUse } from '../schedule.ts';
import { FINAL, type Engine } from './shared.ts';

type Groups = Pick<Engine, 'startGroup' | 'settleGroups' | 'finishPick' | 'useVersion'>;

export function createGroups(engine: Engine): Groups {
  const { logger } = engine.deps;

  /** 用某一版：产出、说明换成那一版的，节点算完成 */
  async function choose(w: Writer, group: Node, child: Node, reason: string, warning?: string) {
    await w.setNode(group.id, {
      status: 'succeeded',
      finishedAt: new Date(),
      outputs: child.outputs,
      summary: child.summary,
      warning: [warning, child.warning].filter(Boolean).join('\n') || null,
      config: {
        ...group.config,
        picking: false,
        chosen: versionOf(child),
        pickReason: reason,
        ...(child.config.outputsRunId ? { outputsRunId: child.config.outputsRunId } : {}),
      },
    });
  }

  /** 展开的每一条都做完了：产出按条目号放进 NN/，各条的提醒合在一起 */
  async function gather(w: Writer, group: Node, children: Node[]) {
    const warnings = children
      .filter((c) => c.warning)
      .map((c) => `第 ${pad2(c.slot ?? 0)} 条：${c.warning}`);
    await w.setNode(group.id, {
      status: 'succeeded',
      finishedAt: new Date(),
      outputs: children.flatMap((c) =>
        c.outputs.map((f) => ({ ...f, path: `${pad2(c.slot ?? 0)}/${f.path}` })),
      ),
      summary: `${children.length} 条都做完了`,
      warning: warnings.length ? warnings.join('\n').slice(0, 4000) : null,
    });
  }

  /** 做几版的节点开出各版：和它一样的做法，各自独立做；AI 版本会被提醒走自己的方向 */
  async function openVersions(w: Writer, nodes: Node[], group: Node) {
    const n = group.config.variants!.n;
    const taken = new Set(nodes.map((x) => x.key));
    const {
      variants: _variants,
      chosen: _chosen,
      pickReason: _reason,
      picking: _picking,
      outputsRunId: _outputs,
      resumeOnStart: _resume,
      ...base
    } = group.config;
    for (let k = 1; k <= n; k += 1) {
      const key = freeKey(`${group.key}-v${k}`, taken);
      taken.add(key);
      await w.addNode({
        id: randomUUID(),
        key,
        title: `${group.title}（第 ${k} 版）`,
        kind: group.kind,
        role: group.role,
        goal: group.goal,
        model: group.model,
        status: 'waiting',
        config: {
          ...base,
          ...(base.budgetMicro
            ? { budgetMicro: Math.max(1, Math.round(base.budgetMicro / n)) }
            : {}),
          version: { k, n },
        },
        parentId: group.id,
        slot: k,
      } as Parameters<Writer['addNode']>[0]);
    }
  }

  return {
    async startGroup(snapshot, w, node, fx) {
      const { resumeOnStart: _resume, repairChecks, revision, ...config } = node.config;
      // 上游有了新产出要跟着更新（整体验收补文件、修改时接着改）：展开节点重新展开（指纹没变的沿用），
      // 做几版的节点各版重做
      const redo = Boolean(repairChecks?.length || revision);
      if (redo && node.kind !== 'foreach')
        for (const child of childrenOf(snapshot.nodes, node))
          await w.retireNode(child.id, snapshot.task.version);
      await w.setNode(node.id, {
        status: 'running',
        startedAt: node.startedAt ?? new Date(),
        finishedAt: null,
        warning: null,
        config: {
          ...config,
          picking: false,
          ...(redo && node.kind === 'foreach' ? { items: undefined } : {}),
        } as Node['config'],
      });
      const children = childrenOf(snapshot.nodes, node);
      if (node.kind === 'foreach' && node.config.items === undefined) {
        fx.expand.push({ taskId: snapshot.task.id, nodeId: node.id });
        return;
      }
      if (node.kind !== 'foreach' && !children.length) {
        await openVersions(w, snapshot.nodes, node);
        return;
      }
      // 接着做：停下的接着原来的运行，失败、取消的重新排队；做完的不动
      for (const child of children) {
        if (child.status === 'stopped')
          await w.setNode(child.id, {
            status: 'waiting',
            config: { ...child.config, resumeOnStart: true },
          });
        else if (child.status === 'failed' || child.status === 'cancelled')
          await w.setNode(child.id, { status: 'waiting', attempts: 0, reworks: 0, warning: null });
      }
    },

    async settleGroups(snapshot, w, fx) {
      const groups = snapshot.nodes
        .filter((n) => isGroup(n) && n.status === 'running')
        .sort((a, b) => depthOf(snapshot.nodes, b) - depthOf(snapshot.nodes, a));
      for (const group of groups) {
        const children = childrenOf(snapshot.nodes, group);
        if (!children.length) continue;
        if (group.kind === 'foreach') {
          if (group.config.items !== undefined && children.every((c) => c.status === 'succeeded'))
            await gather(w, group, children);
          continue;
        }
        if (group.config.picking || !children.every((c) => FINAL.includes(c.status))) continue;
        const done = children.filter((c) => c.status === 'succeeded');
        if (!done.length) {
          await w.setNode(group.id, {
            status: 'failed',
            finishedAt: new Date(),
            warning: `${children.length} 版都没做成`,
          });
          continue;
        }
        if (done.length === 1) {
          const only = done[0]!;
          await choose(w, group, only, `只有第 ${versionOf(only)} 版做成了`);
          continue;
        }
        // 挑选运行也占名额：看图的占工具子节点的池，AI 比较的占 AI 的池；满了等下一轮
        const request = pickRequest(group, done, engine.deps.planning.defaultModel);
        const pool = request.model === TOOL_RUN_MODEL ? 'tool' : 'ai';
        const use = poolUse(snapshot.nodes);
        const { maxParallel, maxToolChildren = maxParallel } = engine.deps;
        if (pool === 'tool' ? use.tools >= maxToolChildren : use.others >= maxParallel) continue;
        logger.info({ nodeId: group.id, versions: done.length }, '各版都做完了，开始挑');
        await w.setNode(group.id, { config: { ...group.config, picking: pool } });
        await engine.openStep(snapshot, w, group, { requests: [request] }, fx);
      }
    },

    async finishPick(w, group, children, result, text) {
      const done = children.filter((c) => c.status === 'succeeded');
      const first = done[0];
      if (result.status === 'stopped' || result.status === 'cancelled' || !first) {
        await w.setNode(group.id, {
          status: result.status === 'cancelled' ? 'cancelled' : 'stopped',
          config: { ...group.config, picking: false },
        });
        return;
      }
      const picked =
        result.status === 'succeeded'
          ? parsePick(text, done.map(versionOf))
          : { problem: `挑选没做成：${result.error ?? '执行器未能完成'}` };
      if ('problem' in picked) {
        logger.warn({ nodeId: group.id, problem: picked.problem }, '没能按标准挑，先用第一版');
        await choose(
          w,
          group,
          first,
          `没能按标准挑，先用第 ${versionOf(first)} 版`,
          `${picked.problem}；先用第 ${versionOf(first)} 版，可以在工作流里改用别的版本`,
        );
        return;
      }
      await choose(
        w,
        group,
        done.find((c) => versionOf(c) === picked.choice)!,
        picked.reason,
      );
    },

    async useVersion(snapshot, w, group, k, reason) {
      const child = childrenOf(snapshot.nodes, group).find((c) => versionOf(c) === k);
      if (!child) return;
      await choose(w, group, child, reason);
      // 这一版属于展开出来的一条：展开节点已经汇总过的，按新的这一版重新汇总
      const parent = snapshot.nodes.find((n) => n.id === group.parentId);
      if (parent?.kind === 'foreach' && parent.status === 'succeeded')
        await gather(w, parent, childrenOf(snapshot.nodes, parent));
    },
  };
}
