// 事务和事务外的副作用：决定都在锁住任务行的事务里做，对外的调用（提交运行、通知 harness 停止或取消、
// 规划、整体验收、关卡检查）等事务提交后再做；各自的失败等对账重试。
import type { RunFinishedData } from '@oasis/contracts/events';
import { RunBody, WORKSPACE_UNAVAILABLE } from '@oasis/contracts/harness';
import { HttpError } from '@oasis/service-kit';
import type { Snapshot, Writer } from '../../repo/task-store.ts';
import { noEffects, type Effects } from '../effects.ts';
import { kindOf } from '../kinds/index.ts';
import { materialPaths } from '../materials.ts';
import { RUN_FINAL, type Engine } from './shared.ts';

export function createOutside(
  engine: Engine,
): Pick<Engine, 'transact' | 'runEffects' | 'submit' | 'reconcileRun'> {
  const { store, harness, logger } = engine.deps;

  /**
   * 接着原会话的运行被 harness 拒绝：原会话的工作目录不在了（持久卷被清掉）。这次运行记成失败，
   * 这一步重新开一个会话做、带上节点上一版交出的产出（ADR 0022 的「重新做」）；不算节点失败，也不占重做次数。
   */
  async function redo(snapshot: Snapshot, w: Writer, runId: string, error: string, fx: Effects) {
    const run = snapshot.activeRuns.find((r) => r.id === runId);
    const node = snapshot.nodes.find((n) => n.id === run?.nodeId);
    if (run?.status !== 'pending' || node?.status !== 'running') return;
    await w.setRun(run.id, { status: 'failed', error, finishedAt: new Date() });
    await engine.openStep(snapshot, w, node, kindOf(node).redo(snapshot, node, run), fx);
  }

  return {
    async transact(taskId, decide) {
      const fx = noEffects();
      await store.transact(taskId, (snapshot, w) => decide(snapshot, w, fx));
      await engine.runEffects(fx);
    },

    async runEffects(fx) {
      for (const intent of fx.abortChecks) engine.abortChecks(intent);
      for (const how of ['stop', 'cancel'] as const) {
        for (const runId of fx[how]) {
          await harness
            .json('POST', `/internal/runs/${runId}/${how}`, { body: {} })
            .catch((err: unknown) => logger.warn({ err, runId, how }, '通知 harness 失败'));
        }
      }
      for (const s of fx.submit) await engine.submit(s);
      for (const job of fx.plan) await engine.planning.submit(job);
      for (const id of fx.accept) {
        await engine
          .runAcceptance(id)
          .catch((err: unknown) => logger.error({ err, taskId: id }, '整体验收失败，等对账重试'));
      }
      for (const g of fx.gate) {
        await engine
          .runGate(g.taskId, g.nodeId, g.runId)
          .catch((err: unknown) => logger.error({ err, ...g }, '关卡检查失败，等对账重试'));
      }
      for (const e of fx.expand) {
        await engine
          .expand(e)
          .catch((err: unknown) => logger.error({ err, ...e }, '展开失败，等对账重试'));
      }
    },

    /** 网络问题时留在 pending，等对账重交；harness 明确拒绝时按运行失败处理 */
    async submit(s) {
      try {
        await harness.json('POST', '/internal/runs', {
          body: {
            runId: s.runId,
            payerId: s.task.payerId,
            taskId: s.task.id,
            nodeId: s.nodeId,
            ...s.request,
            // 每次运行都放一份（接着原会话做时 harness 不会放回上次的素材）
            materials: materialPaths(s.task.materials),
          },
          requestId: s.runId,
          schema: RunBody,
        });
      } catch (err) {
        if (err instanceof HttpError && err.code === WORKSPACE_UNAVAILABLE) {
          logger.warn({ runId: s.runId }, '原会话的工作目录不在了，这一步重新做');
          await engine.transact(s.task.id, (snapshot, w, fx) =>
            redo(snapshot, w, s.runId, err.message, fx),
          );
          return;
        }
        if (err instanceof HttpError && err.statusCode >= 400 && err.statusCode < 500) {
          logger.warn({ err, runId: s.runId }, 'harness 拒绝了运行');
          await engine.onRunFinished({
            runId: s.runId,
            status: 'failed',
            error: err.message,
            outputs: [],
            summary: null,
          });
          return;
        }
        logger.warn({ err, runId: s.runId }, '提交运行失败，等对账重交');
        return;
      }
      await store.transact(s.task.id, async (snapshot, w) => {
        const run = snapshot.activeRuns.find((r) => r.id === s.runId);
        if (run?.status === 'pending') await w.setRun(s.runId, { status: 'running' });
      });
    },

    async reconcileRun(run) {
      let remote: RunBody | undefined;
      try {
        remote = await harness.json('GET', `/internal/runs/${run.id}`, { schema: RunBody });
      } catch (err) {
        if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
      }
      if (remote && RUN_FINAL.includes(remote.status)) {
        await engine.onRunFinished({
          runId: run.id,
          status: remote.status as RunFinishedData['status'],
          error: remote.error,
          outputs: remote.outputs,
          summary: remote.summary,
          resumable: remote.resumable,
        });
      } else if (!remote) {
        const snapshot = await store.get(run.taskId);
        if (snapshot) {
          await engine.submit({
            runId: run.id,
            task: snapshot.task,
            nodeId: run.nodeId,
            request: run.request,
          });
        }
      }
    },
  };
}
