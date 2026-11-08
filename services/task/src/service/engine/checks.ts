// 关卡和整体验收（ADR 0017：检查只提醒、不拦截）。检查在事务外跑，结果回到事务里推进：
// 明确没满足的接着原会话改一次（MAX_REWORKS），改过仍没满足、没检查到的都带着提醒往下走。
import { isGroup } from '../groups.ts';
import { kindOf, reworkStep } from '../kinds/index.ts';
import { missingDeliveryFiles, selectDeliverables } from '../output-files.ts';
import type { Engine } from './shared.ts';

/**
 * 检查明确没满足时最多自动改几次（ADR 0004 §2，2026-11-05 用户重申）：改过之后照常往下走、带提醒交付。
 * 检查只提醒、不拦截——任务只会因为用户停止或网络长时间连不上而停下。
 */
const MAX_REWORKS = 1;

export function createChecks(
  engine: Engine,
): Pick<Engine, 'runGate' | 'runAcceptance' | 'abortChecks'> {
  const { store, gate, logger } = engine.deps;
  /** 进行中的检查：同一个检查只跑一份；节点被停止、任务被取消时停掉 */
  const inFlight = new Map<
    string,
    { taskId: string; nodeId?: string; abort: AbortController; pending: Promise<void> }
  >();

  function checkOnce(
    key: string,
    owner: { taskId: string; nodeId?: string },
    check: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const existing = inFlight.get(key);
    if (existing) return existing.pending;
    const abort = new AbortController();
    const pending = Promise.resolve()
      .then(() => check(abort.signal))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, { ...owner, abort, pending });
    return pending;
  }

  /** 关卡：通过 → 完成；没过且还能改 → 接着原会话改一次；否则完成并留提醒 */
  async function checkNode(
    taskId: string,
    nodeId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = await store.get(taskId);
    const node = snapshot?.nodes.find((n) => n.id === nodeId);
    if (!snapshot || node?.status !== 'checking' || node.currentRunId !== runId) return;
    // 检查轻量化（ADR 0017）：只挡明显坏掉的成果，任务单要求由节点自己对照
    const { unmet, unchecked } = await gate.check({
      signal,
      payerId: snapshot.task.payerId,
      taskId,
      nodeId,
      runId,
      outputs: node.outputs,
      expects: [...(node.config.expects ?? []), ...(node.config.deliver ?? [])],
      deliver: node.config.deliver ?? [],
    });
    await engine.transact(taskId, async (fresh, w, fx) => {
      // 检查期间节点被停止、任务被取消：结果作废
      const current = fresh.nodes.find((n) => n.id === nodeId);
      if (current?.status !== 'checking' || current.currentRunId !== runId) return;
      // 明确没满足：接着原会话改，最多 MAX_REWORKS 次；其余（改过仍没满足、没检查到）都记成提醒往下走。
      // 没有 AI 能改的节点（工具节点）不返工，直接带着提醒往下走
      const reworkable = kindOf(current).reworkable;
      if (unmet.length && reworkable && current.reworks < MAX_REWORKS) {
        logger.info({ nodeId, unmet }, '关卡没过，接着原会话修改一次');
        await w.setNode(nodeId, { reworks: current.reworks + 1 });
        await engine.openStep(fresh, w, current, reworkStep(current, unmet), fx);
      } else {
        const reminders = [
          ...(unmet.length
            ? [`${reworkable ? '改过一次仍可能没满足' : '没满足'}：${unmet.join('；')}`]
            : []),
          ...(unchecked?.length ? [`没检查到：${unchecked.join('；')}`] : []),
        ];
        await w.setNode(nodeId, {
          status: 'succeeded',
          finishedAt: new Date(),
          warning: reminders.length ? reminders.join('\n') : null,
        });
      }
      await engine.schedule(fresh, w, fx);
    });
  }

  /**
   * 整体验收（ADR 0005 §5，ADR 0017 起只查交付文件齐不齐）：缺文件的交付节点接着原会话补一次，
   * 补过仍缺就带着记录交付。节点关卡已经跑过文件、网页和音视频检查，任务单的要求由节点自己对照。
   */
  async function checkDelivery(taskId: string): Promise<void> {
    const snapshot = await store.get(taskId);
    if (snapshot?.task.status !== 'accepting' || !snapshot.task.sheet) return;
    const { task } = snapshot;
    const missing: string[] = [];
    /** 交付不齐的节点：只让它们补，交齐了的不动 */
    const short = new Set<string>();
    const deliverables = selectDeliverables(task.deliverables, snapshot.nodes);
    for (const owner of new Set(deliverables.map((d) => d.nodeId))) {
      const node = snapshot.nodes.find((n) => n.id === owner);
      const lacking = node ? missingDeliveryFiles(node.outputs, node.config.deliver) : [];
      if (lacking.length) short.add(node!.id);
      missing.push(...lacking);
    }
    for (const d of deliverables) {
      const node = snapshot.nodes.find((n) => n.id === d.nodeId);
      if (!node?.config.outputsRunId || (d.files ?? node.outputs).length === 0) {
        missing.push(`「${d.name}」没有交出文件`);
        if (node) short.add(node.id);
      }
    }
    const revision = task.acceptance?.revision;
    await engine.transact(taskId, async (fresh, w, fx) => {
      if (fresh.task.status !== 'accepting') return;
      const repairs = fresh.task.acceptance?.repairs ?? 0;
      await w.setTask({
        acceptance: {
          unmet: missing,
          ...(repairs ? { repairs } : {}),
          ...(revision !== undefined ? { revision } : {}),
        },
        deliverables,
        finishedAt: null,
      });
      // 交付文件不齐：缺文件的交付节点接着原会话补一次；补过之后照常交付，缺的记在验收记录里。
      // 工具节点自己补不了（同样的步骤再跑一遍还是缺），只在下游跟着上游的新产出重跑
      // 做几版的节点（ADR 0026）也补不了：交的是挑中的那一版
      const targets = fresh.nodes.filter(
        (n) => short.has(n.id) && n.currentRunId && kindOf(n).reworkable && !isGroup(n),
      );
      if (missing.length && repairs < MAX_REWORKS && targets.length) {
        await w.setTask({
          status: 'running',
          attention: null,
          acceptance: { ...fresh.task.acceptance!, repairs: repairs + 1 },
        });
        const affected = engine.withDownstream(fresh, targets);
        for (const node of fresh.nodes.filter((n) => affected.has(n.id)))
          await w.setNode(node.id, {
            status: 'waiting',
            finishedAt: null,
            config: { ...node.config, repairChecks: missing },
          });
        await engine.schedule(fresh, w, fx);
      } else await w.setTask({ status: 'succeeded', attention: null, finishedAt: new Date() });
    });
  }

  return {
    runGate: (taskId, nodeId, runId) =>
      checkOnce(`node:${taskId}:${nodeId}:${runId}`, { taskId, nodeId }, (signal) =>
        checkNode(taskId, nodeId, runId, signal),
      ),
    runAcceptance: (taskId) =>
      checkOnce(`accept:${taskId}`, { taskId }, () => checkDelivery(taskId)),
    abortChecks(intent) {
      for (const check of inFlight.values())
        if (check.taskId === intent.taskId && (!intent.nodeId || check.nodeId === intent.nodeId))
          check.abort.abort();
    },
  };
}
