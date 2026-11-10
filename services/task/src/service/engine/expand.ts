// 展开节点读清单（ADR 0026）：事务外从上游交出的产出里读 JSON 清单、按条套上做法、核对工具参数，
// 事务里开子节点。重新展开（修改）时指纹（这一条、做法、用到的上游产出）没变的子节点沿用：做成了的不重做。
// 清单格式不对：上游是 AI 节点、下游别的节点还没开始时让上游接着原会话改一次清单；否则展开节点失败交给用户。
// 读文件时连不上 harness：先放着，对账时再读（listExpanding）。
import { randomUUID } from 'node:crypto';
import { FOREACH_MAX, type PlanNode } from '@oasis/contracts/task';
import { HttpError } from '@oasis/service-kit';
import type { Node, NodeOf, Snapshot, Writer } from '../../repo/task-store.ts';
import {
  childrenOf,
  fillTemplate,
  freeKey,
  isGroup,
  itemHash,
  listItems,
  pad2,
} from '../groups.ts';
import { kindOf, refsOf, upstreamOf } from '../kinds/index.ts';
import { nodeRow } from '../plan.ts';
import { estimatePlan } from '../planner.ts';
import type { Engine } from './shared.ts';

type Foreach = NodeOf<'foreach'>;
type Prepared = { plan: PlanNode; item: unknown };
const NOT_STARTED = ['draft', 'waiting', 'blocked'];

/** 清单在哪：over 写成 in/<上游 key>/<文件> */
function sourceOf(snapshot: Snapshot, node: Foreach) {
  const [, key = '', ...rest] = (node.config.over ?? '').split('/');
  return { key, file: rest.join('/'), node: upstreamOf(snapshot, node).find((u) => u.key === key) };
}

/** 一条要做的事：做法里的模板换成这一条，节点名接上条目号 */
function branchFor(node: Foreach, index: number, item: unknown, missing: string[]): PlanNode {
  const { title, ...rest } = fillTemplate(node.config.each!, index, item, missing);
  return {
    ...rest,
    key: `${node.key}-${pad2(index)}`,
    title: (title ?? `${node.title} ${pad2(index)}`).slice(0, 60),
  } as PlanNode;
}

/** 这一条用到的上游产出（指纹用）：点名用到的；AI 节点还能翻看清单以外的全部上游 */
function usedRuns(snapshot: Snapshot, node: Foreach, plan: PlanNode): string[] {
  const text = JSON.stringify(plan);
  const list = sourceOf(snapshot, node).key;
  return upstreamOf(snapshot, node).flatMap((u) => {
    const refs = refsOf(snapshot, u);
    if (plan.kind === 'work' && u.kind !== 'foreach' && u.key !== list)
      return refs.map((r) => r.runId);
    const whole = new RegExp(`in/${u.key}/(?!\\d{2}/)`, 'u').test(text);
    return refs
      .filter((r) => text.includes(`in/${r.as}/`) || (r.as.includes('/') && whole))
      .map((r) => r.runId);
  });
}

/** 做法里用到的字段（清单格式不对时告诉上游要有哪些） */
const fieldsOf = (each: unknown) => [
  ...new Set(
    [...JSON.stringify(each).matchAll(/\{\{\s*item\.([\p{L}\p{N}_-]+)/gu)].map((m) => m[1]),
  ),
];

export function createExpand(engine: Engine): Pick<Engine, 'expand'> {
  const { store, harness, logger } = engine.deps;

  async function readList(snapshot: Snapshot, node: Foreach) {
    const { key, file, node: source } = sourceOf(snapshot, node);
    if (!source)
      return { problem: `清单 ${node.config.over} 不是上游交来的（要连线 ${key} → ${node.key}）` };
    const runId = source.config.outputsRunId;
    if (!runId || !source.outputs.some((f) => f.path === file))
      return { problem: `上游「${source.title}」没有交出 ${file}` };
    let text: string;
    try {
      const response = await harness.stream(
        'GET',
        `/internal/runs/${runId}/files/${file.split('/').map(encodeURIComponent).join('/')}`,
      );
      text = await response.text();
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404)
        return { problem: `上游「${source.title}」交出的 ${file} 读不到` };
      throw err;
    }
    const parsed = listItems(text);
    return 'problem' in parsed ? { problem: `${node.config.over} ${parsed.problem}` } : parsed;
  }

  /** 读清单、套做法、核对参数；返回要开的每一条和每条的预估，或者问题 */
  async function prepare(
    snapshot: Snapshot,
    node: Foreach,
  ): Promise<{ problem: string } | { prepared: Prepared[]; perItem: number }> {
    const read = await readList(snapshot, node);
    if ('problem' in read) return { problem: read.problem };
    const { models, tools } = await engine.planning.pricing(snapshot.task.payerId);
    const byKey = new Map(tools.map((t) => [t.key, t]));
    const problems: string[] = [];
    const prepared: Prepared[] = read.items.map((item, i) => {
      const missing: string[] = [];
      const plan = branchFor(node, i + 1, item, missing);
      if (missing.length)
        problems.push(`第 ${pad2(i + 1)} 条没有 ${[...new Set(missing)].join('、')}`);
      else if (plan.kind === 'tool')
        problems.push(
          ...kindOf(plan)
            .toolProblems(plan, byKey)
            .map((p) => `第 ${pad2(i + 1)} 条：${p}`),
        );
      return { plan, item };
    });
    if (problems.length) return { problem: problems.slice(0, 5).join('；') };
    const perItem = estimatePlan(
      { nodes: [prepared[0]!.plan], edges: [] },
      models,
      tools,
      engine.deps.planning.fallback,
    ).totalMicro;
    return { prepared, perItem };
  }

  /** 开出每一条：指纹相同的旧子节点沿用（换到新位置），其余旧的移出，新的新建 */
  async function apply(
    snapshot: Snapshot,
    w: Writer,
    node: Foreach,
    prepared: Prepared[],
    perItem: number,
  ) {
    const old = childrenOf(snapshot.nodes, node);
    const hashes = prepared.map((p) =>
      itemHash(p.item, node.config.each, usedRuns(snapshot, node, p.plan)),
    );
    const kept = new Map<number, Node>();
    for (const [i, hash] of hashes.entries()) {
      const match = old.find((c) => c.config.itemHash === hash && ![...kept.values()].includes(c));
      if (match) kept.set(i, match);
    }
    const keptNodes = new Set(kept.values());
    for (const child of old.filter((c) => !keptNodes.has(c)))
      await w.retireNode(child.id, snapshot.task.version);
    // 沿用的先改成临时名，免得换位置时和别的条目撞名
    for (const child of keptNodes)
      await w.setNode(child.id, { key: `${child.key}~${child.id.slice(0, 8)}` });
    const taken = new Set(snapshot.nodes.filter((n) => !keptNodes.has(n)).map((n) => n.key));
    const share = node.config.budgetMicro
      ? Math.max(1, Math.round(node.config.budgetMicro / prepared.length))
      : undefined;
    for (const [i, { plan, item }] of prepared.entries()) {
      const key = freeKey(plan.key, taken);
      taken.add(key);
      const child = kept.get(i);
      if (child) {
        const again =
          child.status === 'succeeded'
            ? {}
            : {
                status: 'waiting' as const,
                attempts: 0,
                reworks: 0,
                warning: null,
                ...(child.status === 'stopped'
                  ? { config: { ...child.config, resumeOnStart: true } }
                  : {}),
              };
        await w.setNode(child.id, { key, slot: i + 1, title: plan.title, ...again });
        continue;
      }
      const row = nodeRow({ ...plan, key }, randomUUID(), 'waiting', share);
      await w.addNode({
        ...row,
        config: { ...row.config, item, itemHash: hashes[i] },
        parentId: node.id,
        slot: i + 1,
      } as Parameters<Writer['addNode']>[0]);
    }
    await w.setNode(node.id, {
      outputs: [],
      summary: null,
      config: { ...node.config, items: prepared.length },
    });
    // 第一次展开：条数和规划时预计的不一样，预估跟着改
    const count = node.config.count ?? prepared.length;
    if (!old.length && count !== prepared.length && snapshot.task.estimateMicro !== null)
      await w.setTask({
        estimateMicro: Math.max(
          0,
          snapshot.task.estimateMicro + (prepared.length - count) * perItem,
        ),
      });
    logger.info({ nodeId: node.id, items: prepared.length, kept: kept.size }, '展开了清单');
  }

  /** 清单不能用：能让上游改一次就改一次，否则展开节点失败交给用户 */
  async function listProblem(snapshot: Snapshot, w: Writer, node: Foreach, problem: string) {
    const source = sourceOf(snapshot, node).node;
    const othersStarted = snapshot.edges
      .filter((e) => source && e.fromNodeId === source.id && e.toNodeId !== node.id)
      .some(
        (e) => !NOT_STARTED.includes(snapshot.nodes.find((n) => n.id === e.toNodeId)?.status ?? ''),
      );
    const repairs = node.config.listRepairs ?? 0;
    if (
      source &&
      repairs < 1 &&
      kindOf(source).reworkable &&
      !isGroup(source) &&
      source.currentRunId &&
      !othersStarted
    ) {
      const fields = fieldsOf(node.config.each);
      logger.info({ nodeId: node.id, problem }, '清单格式不对，让上游改一次');
      await w.setNode(node.id, {
        status: 'waiting',
        config: { ...node.config, listRepairs: repairs + 1 },
      });
      await w.setNode(source.id, {
        status: 'waiting',
        finishedAt: null,
        config: {
          ...source.config,
          repairChecks: [
            `${node.config.over} 要能逐条展开，现在${problem}。写成 JSON 数组，每条一项，最多 ${FOREACH_MAX} 条${fields.length ? `，每条要有 ${fields.join('、')}` : ''}`,
          ],
        },
      });
      return;
    }
    await w.setNode(node.id, { status: 'failed', finishedAt: new Date(), warning: problem });
    await w.setTask({
      status: 'needs_attention',
      attention: {
        reason: 'node_failed',
        nodeId: node.id,
        message: `「${node.title}」没法展开：${problem}`,
      },
    });
  }

  return {
    async expand({ taskId, nodeId }) {
      const snapshot = await store.get(taskId);
      const node = snapshot?.nodes.find((n) => n.id === nodeId);
      if (
        !snapshot ||
        node?.kind !== 'foreach' ||
        node.status !== 'running' ||
        node.config.items !== undefined
      )
        return;
      let result: Awaited<ReturnType<typeof prepare>>;
      try {
        result = await prepare(snapshot, node);
      } catch (err) {
        logger.warn({ err, nodeId }, '读不到清单，等对账再读');
        return;
      }
      await engine.transact(taskId, async (fresh, w, fx) => {
        const current = fresh.nodes.find((n) => n.id === nodeId);
        if (
          current?.kind !== 'foreach' ||
          current.status !== 'running' ||
          current.config.items !== undefined
        )
          return;
        if ('problem' in result) await listProblem(fresh, w, current, result.problem);
        else await apply(fresh, w, current, result.prepared, result.perItem);
        await engine.schedule(fresh, w, fx);
      });
    },
  };
}
