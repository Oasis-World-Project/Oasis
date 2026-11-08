// 停止、取消、重启接管、服务关闭。用户的停止 / 取消意图先写进运行事件再生效，接管等待期间也不会丢；
// 服务重启后单实例接管：先停旧进程，再恢复原身份和原工作目录，不发布中间失败。
import { StartRunBody as StartRunSchema } from '@oasis/contracts/harness';
import type { DurableRunRequest, Run } from '../../repo/runs-repo.ts';
import { isPrivateOutput, newLiveRun, StopRun, type RunContext } from './shared.ts';

export function createControl(ctx: RunContext) {
  const { deps, state } = ctx;
  const { repo, executor, logger } = deps;
  let recoveringRuns = false;
  let recoveryDone: Promise<void> = Promise.resolve();

  async function requestControl(id: string, how: 'stop' | 'cancel') {
    state.controlRequests.set(id, how);
    const run = state.live.get(id);
    const seq = run ? run.nextSeq++ : undefined;
    const writing = (run?.writes ?? state.controlWrites.get(id) ?? Promise.resolve()).then(
      async () =>
        repo.appendEvents(id, [
          {
            seq: seq ?? (await repo.nextSequence(id)),
            kind: 'status',
            data: { status: 'control_requested', how },
          },
        ]),
    );
    if (run) run.writes = writing;
    state.controlWrites.set(id, writing);
    try {
      await writing;
    } catch (err) {
      state.controlRequests.delete(id);
      throw err;
    } finally {
      if (state.controlWrites.get(id) === writing) state.controlWrites.delete(id);
    }
  }

  /** 接管等待期间的用户控制意图也必须生效，不能因当前没有 LiveRun 而丢掉。 */
  async function restoreControl(row: Run): Promise<boolean> {
    await state.controlWrites.get(row.id);
    const stored = await repo.control(row.id);
    const how = state.controlRequests.get(row.id) ?? stored;
    if (!how) return false;
    const saved =
      how === 'stop' && executor.readStoredArchive
        ? await ctx.save(
            { readArchive: (path) => executor.readStoredArchive!(row.id, path) },
            row.id,
          )
        : {};
    await deps.modelGateway.json('POST', `/internal/v1/tools/runs/${row.id}/cancel`, {
      body: {},
      requestId: row.id,
      headers: {
        'x-oasis-payer-id': row.payerId,
        ...(row.taskId ? { 'x-oasis-task-id': row.taskId } : {}),
      },
    });
    await state.controlWrites.get(row.id);
    const latest = state.controlRequests.get(row.id) ?? (await repo.control(row.id)) ?? how;
    await ctx.finish(row, {
      status: latest === 'cancel' ? 'cancelled' : 'stopped',
      error: latest === 'cancel' ? '已取消' : '已停止',
      outputs: saved.outputs?.files.filter((f) => !isPrivateOutput(f.path)) ?? row.outputs,
      outputKey: saved.outputs?.key ?? row.outputKey,
      summary: row.summary,
    });
    state.controlRequests.delete(row.id);
    return true;
  }

  /** 停止或取消：排队中的不再开始；运行中的按原因中止；已结束的不受影响，不报错 */
  async function control(id: string, how: 'stop' | 'cancel') {
    const row = await ctx.owned(id);
    const run = state.live.get(id);
    if (!['queued', 'starting', 'running'].includes(row.status)) return;
    // 已经在收尾（马上就成功了）的运行不停
    if (how === 'stop' && run?.closing && !run.suspended) return;
    await requestControl(id, how);
    if (run) {
      run.suspended = false;
      run.abort.abort(
        how === 'stop' ? new StopRun('stopped', '已停止') : new StopRun('cancelled', '已取消'),
      );
    } else {
      void ctx
        .recover()
        .catch((err: unknown) =>
          logger.warn(
            { err, runId: id },
            how === 'stop' ? '停止意图已保存，等待接管执行' : '取消意图已保存，等待接管执行',
          ),
        );
    }
  }

  /** 接管一次运行：作废旧 Key、结清旧算力，用户已经要停的就停，否则在原工作目录里接着跑 */
  async function takeOver(row: Run) {
    const suspended = await executor.suspend?.(row.id);
    const savedStop = !suspended ? await repo.suspension?.(row.id) : undefined;
    const checkpoint =
      savedStop && (row.status === 'queued' || savedStop.keyId === row.runKeyId)
        ? savedStop
        : undefined;
    const endedAt = suspended?.endedAt ?? (checkpoint ? new Date(checkpoint.endedAt) : new Date());
    if (row.runKeyId) {
      await deps.modelGateway.json('POST', `/internal/run-keys/${row.runKeyId}/revoke`, {
        body: {},
        requestId: row.id,
      });
    }
    await deps.modelGateway.json('POST', `/internal/v1/compute/runs/${row.id}/recover`, {
      body: {
        payerId: row.payerId,
        cores: suspended?.cores ?? checkpoint?.cores ?? deps.cores,
        endedAt: endedAt.toISOString(),
      },
      requestId: row.id,
    });
    if (await restoreControl(row)) return;
    let request: DurableRunRequest;
    try {
      const saved = (await repo.request(row.id)) as DurableRunRequest | undefined;
      if (!saved) throw new Error('没有与运行原子保存的启动请求');
      request = { body: StartRunSchema.parse(saved.body) };
      if (row.startedAt && !(await executor.workspaceExists(row.sessionId ?? row.id)))
        throw new Error('原运行持久工作目录缺失，不能从空目录恢复');
    } catch (err) {
      await ctx.finish(row, {
        status: 'failed',
        error: '恢复状态不可用：' + (err instanceof Error ? err.message : String(err)),
        outputs: row.outputs,
        outputKey: row.outputKey,
        summary: row.summary,
      });
      return;
    }
    const catalog = await ctx.admit(row.model, request.body.requires);
    const run = newLiveRun(await repo.nextSequence(row.id), row.sessionId ?? row.id);
    if (await restoreControl(row)) return;
    state.live.set(row.id, run);
    ctx.record(row.id, run, 'status', { status: 'recovering', sessionId: run.sessionId });
    run.done = ctx
      .execute(
        row,
        request.body.inputs.map((f) => ({
          path: f.path,
          content: Buffer.from(f.contentBase64, 'base64'),
        })),
        request.body.materials ?? [],
        run,
        {
          goal: request.body.goal ?? false,
          ...(request.body.reasoningEffort
            ? { reasoningEffort: request.body.reasoningEffort }
            : {}),
          ...(request.body.steps ? { steps: request.body.steps } : {}),
        },
        catalog,
        Boolean(row.startedAt),
      )
      .catch((err: unknown) => logger.error({ err, runId: row.id }, '恢复运行收尾失败'));
  }

  return {
    /**
     * 停止：排队中的不再开始；运行中的先存下产出再销毁沙箱（会话和工作目录在持久卷里），之后可以接着做。
     * 已经在收尾（马上就成功了）或已结束的不受影响，不报错。
     */
    stop: (id: string) => control(id, 'stop'),

    /** 取消：排队中的不再开始，运行中的立即销毁沙箱。已结束的取消不报错。 */
    cancel: (id: string) => control(id, 'cancel'),

    /** 单实例启动接管：先停旧进程，再恢复原身份和原工作目录；不发布中间失败。 */
    async recover(): Promise<void> {
      if (state.closing) return;
      if (recoveringRuns) return recoveryDone;
      recoveringRuns = true;
      let complete!: () => void;
      recoveryDone = new Promise<void>((resolve) => {
        complete = resolve;
      });
      try {
        for (const row of await repo.listUnfinished()) {
          if (state.live.has(row.id) || state.sessions.has(row.sessionId ?? row.id)) continue;
          try {
            await takeOver(row);
          } catch (err) {
            const error = '接管等待：' + (err instanceof Error ? err.message : String(err));
            if (error !== row.error) {
              await repo.update(row.id, { error });
              await repo.appendEvents(row.id, [
                {
                  seq: await repo.nextSequence(row.id),
                  kind: 'status',
                  data: { status: 'recovery_wait', reason: error },
                },
              ]);
            }
            logger.warn({ err, runId: row.id }, '接管依赖暂未恢复，保留原进度');
          }
        }
        const keep = new Set([
          ...state.live.keys(),
          ...(await repo.listUnfinished()).map((r) => r.id),
        ]);
        const removed = await executor.removeOrphans(keep);
        if (removed > 0) logger.info({ removed }, '清理了遗留的沙箱容器');
      } finally {
        recoveringRuns = false;
        complete();
      }
    },

    /** 服务关闭：中止所有进行中的运行并等它们收尾。 */
    async stopAll(): Promise<void> {
      state.closing = true;
      await recoveryDone;
      const runs = [...state.live.values()];
      for (const [id, run] of state.live) {
        if (run.closing) continue;
        if (state.controlRequests.has(id) || (run.abort.signal.aborted && !run.suspended)) continue;
        run.suspended = true;
        run.abort.abort(new StopRun('stopped', '执行服务关闭，进度保留待接管'));
      }
      await Promise.all(runs.map((run) => run.done));
    },
  };
}
