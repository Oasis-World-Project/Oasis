// 运行结束：记下结局，再按结局推进节点——交出了产出去过关卡，这一步还没完（讨论发言）交给种类插件，
// 失败了能换模型就换、否则节点失败交给用户处理，不是这里发起的停止或取消就让整个节点跟着停。
import type { Node, NodeRun, Snapshot, Writer } from '../../repo/task-store.ts';
import type { Effects } from '../effects.ts';
import { kindOf, openRuns } from '../kinds/index.ts';
import type { Engine } from './shared.ts';

/** 上游拒绝「地区不可用」时运行的错误里带的代码（model-gateway 给的） */
const REGION_UNAVAILABLE = 'provider_region_unavailable';

export function createFinish(engine: Engine): Pick<Engine, 'onRunFinished'> {
  const { store, logger } = engine.deps;

  /** 把这次运行用的模型换掉（讨论发言换那位参与者的，其余换节点的）；节点上留一条提醒 */
  async function switchModel(w: Writer, node: Node, run: NodeRun, model: string) {
    const who = run.meta.participant;
    const note = `${who ? `「${who}」` : ''}原定的模型 ${run.request.model} 在当前网络用不了，改用 ${model}`;
    const warning = [node.warning, note].filter(Boolean).join('；');
    await w.setNode(node.id, { ...kindOf(node).switchModel(node, run, model), warning });
  }

  /** 节点的一次运行失败：模型在当前网络用不了就换默认模型再做，否则节点失败、任务交给用户处理 */
  async function onFailure(
    snapshot: Snapshot,
    w: Writer,
    node: Node,
    run: NodeRun,
    error: string | null,
    fx: Effects,
  ) {
    const fallback = engine.deps.planning.defaultModel;
    if (error?.includes(REGION_UNAVAILABLE) && run.request.model !== fallback) {
      // 重试也没用，换默认模型接着做，不算一次重做
      logger.info(
        { nodeId: node.id, model: run.request.model },
        '模型在当前网络用不了，换默认模型',
      );
      await switchModel(w, node, run, fallback);
      await engine.openStep(snapshot, w, node, kindOf(node).retry(snapshot, node, run), fx);
      return;
    }
    // 讨论里其他人还在说：一起停掉
    await engine.endRuns(w, openRuns(snapshot, node.id), 'cancel', fx);
    await w.setNode(node.id, { status: 'failed', finishedAt: new Date() });
    await w.setTask({
      status: 'needs_attention',
      attention: {
        reason: 'node_failed',
        nodeId: node.id,
        message: `「${node.title}」未完成：${error ?? '执行器未能完成任务'}`,
      },
    });
  }

  return {
    async onRunFinished(result) {
      const found = await store.findRun(result.runId);
      if (!found) return engine.planning.onFinished(result); // 不是节点的运行：可能是规划员
      await engine.transact(found.taskId, async (snapshot, w, fx) => {
        const run = snapshot.activeRuns.find((r) => r.id === result.runId);
        if (!run) return; // 已经处理过
        await w.setRun(run.id, {
          status: result.status,
          meta: { ...run.meta, resumable: result.resumable ?? false },
          summary: result.summary,
          error: result.error,
          outputs: result.outputs,
          finishedAt: new Date(),
        });
        const node = snapshot.nodes.find((n) => n.id === run.nodeId);
        if (node?.status !== 'running') return; // 节点已停止、已取消、已失败等：不再推进
        const kind = kindOf(node);
        if (!kind.current(node, run)) return; // 过期的运行

        if (result.status === 'cancelled' || result.status === 'stopped') {
          // 不是这里发起的停止或取消（如 harness 被关掉）：整个节点跟着停
          await engine.endRuns(
            w,
            openRuns(snapshot, node.id),
            result.status === 'stopped' ? 'stop' : 'cancel',
            fx,
          );
          await w.setNode(node.id, {
            status: result.status,
            ...(result.status === 'cancelled' ? { finishedAt: new Date() } : {}),
          });
        } else if (result.status === 'failed') {
          await onFailure(
            snapshot,
            w,
            node,
            { ...run, meta: { ...run.meta, resumable: result.resumable ?? false } },
            result.error,
            fx,
          );
        } else {
          const outcome = kind.succeeded(snapshot, node, run, result.summary);
          if (outcome.deliver) {
            // 交出了产出（干活、修改、汇总）：先过关卡
            await w.setNode(node.id, {
              status: 'checking',
              summary: result.summary,
              outputs: result.outputs,
              currentRunId: run.id,
              config: { ...node.config, outputsRunId: run.id },
            });
            fx.gate.push({ taskId: snapshot.task.id, nodeId: node.id, runId: run.id });
          } else {
            // 这一步还没完（如讨论的发言）：记下，需要时开下一步
            await w.setNode(node.id, { config: outcome.config });
            if (outcome.next) await engine.openStep(snapshot, w, node, outcome.next, fx);
          }
        }
        await engine.schedule(snapshot, w, fx);
      });
    },
  };
}
