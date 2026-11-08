// 一次 agent 运行的完整生命周期：
// 排队 → 签发临时 Key → 起沙箱（挂上这个会话的持久工作目录）、放入输入 → dsh 握手、交任务
// → 记录事件 → 等空闲（期间可追问）→ 取出产出存进对象存储 → 销毁沙箱、作废 Key
// → 写结局并发出 harness.run.finished。
// 工作目录和 dsh 会话在持久卷里（ADR 0015 §9），沙箱销毁后还在：停止、失败、关卡退回、修改时用
// continueFrom 接着原会话做，AI 记得之前做到哪了。对象存储只存产出，不存会话。
// 持久卷不在了就接不上原会话（409 workspace_unavailable），由 task 改成重新做、带上上一版产出。
// 这里是对外接口和登记新运行；执行、搬文件、停止与接管、读产出分别在 run/ 下。
import { randomUUID } from 'node:crypto';
import { type RunBody, type StartRunBody, WORKSPACE_UNAVAILABLE } from '@oasis/contracts/harness';
import { HttpError } from '@oasis/service-kit';
import type { Run } from '../repo/runs-repo.ts';
import { createControl } from './run/control.ts';
import { createExecution } from './run/execute.ts';
import { createOutputs } from './run/outputs.ts';
import { createGate, newLiveRun, toRunBody, type RunContext, type RunDeps } from './run/shared.ts';
import { createStorage } from './run/storage.ts';

export function createRunService(deps: RunDeps) {
  const { repo, executor, store, logger } = deps;
  const state: RunContext['state'] = {
    live: new Map(),
    sessions: new Set(),
    controlRequests: new Map(),
    controlWrites: new Map(),
    closing: false,
    gate: createGate(deps.maxConcurrent),
  };
  async function owned(id: string): Promise<Run> {
    const row = await repo.get(id);
    if (!row) throw new HttpError(404, 'run_not_found', '没有这次运行');
    return row;
  }
  const ctx = {
    deps,
    state,
    owned,
    bodyOf: async (row: Run) =>
      toRunBody(row, await executor.workspaceExists(row.sessionId ?? row.id)),
  } as RunContext;
  Object.assign(ctx, createStorage(ctx), createExecution(ctx));
  const control = createControl(ctx);
  ctx.recover = control.recover;
  const { live, sessions } = state;

  /** 接着之前的运行：同一付费人、已结束、持久工作目录还在、会话没有更新的运行 */
  async function continuable(body: StartRunBody, runId: string): Promise<Run> {
    // 刚点了停止马上点继续：那次运行还在收尾（停沙箱、存产出），等它真正停好再接着，
    // 不能当成「还没结束」拒掉（2026-11-08 回归测试发现：拒掉后节点失败、会话被取消）
    const stopping = live.get(runId);
    if (stopping?.abort.signal.aborted) await stopping.done;
    const previous = await repo.get(runId);
    const ended = ['succeeded', 'failed', 'cancelled', 'stopped'].includes(previous?.status ?? '');
    if (!previous || previous.payerId !== body.payerId || !ended)
      throw new HttpError(409, 'continue_unavailable', '要接着的那次运行不存在或还没结束');
    const session = previous.sessionId ?? previous.id;
    // 只有对象存储里的产出、没有会话，不能冒充接着原会话做
    if (!(await executor.workspaceExists(session)))
      throw new HttpError(409, WORKSPACE_UNAVAILABLE, '原会话的工作目录已经不在了，接不上原会话');
    const history = await repo.listBySession(session);
    if (history.some((r) => r.id !== previous.id && r.createdAt > previous.createdAt))
      throw new HttpError(409, 'session_advanced', '该会话已有后续运行，请从最新进度继续');
    return previous;
  }

  return {
    async start(
      body: StartRunBody & Required<Pick<StartRunBody, 'inputs' | 'inputsFrom'>>,
    ): Promise<RunBody> {
      if (state.closing)
        throw new HttpError(503, 'harness_closing', '执行服务正在重启，请稍后重交');
      if (body.runId) {
        const existing = await repo.get(body.runId);
        if (existing) {
          if (existing.payerId !== body.payerId || existing.model !== body.model)
            throw new HttpError(409, 'run_id_conflict', '这个运行 ID 已经被别的运行用了');
          return ctx.bodyOf(existing);
        }
      }
      // 目录未就绪属于准入等待，不登记失败运行，也不消耗节点重试次数。
      const catalog = await ctx.admit(body.model, body.requires);
      // 只能拿同一付费人、已成功的运行的产出当输入
      for (const ref of body.inputsFrom) {
        const upstream = await repo.get(ref.runId);
        if (upstream?.payerId !== body.payerId || upstream.status !== 'succeeded') {
          throw new HttpError(
            409,
            'input_run_unavailable',
            `上游运行 ${ref.runId} 不存在或没有成功`,
          );
        }
      }
      // 接着之前的运行：没另给输入就沿用它的输入
      const previous = body.continueFrom ? await continuable(body, body.continueFrom) : undefined;
      const id = body.runId ?? randomUUID();
      const sessionId = previous ? (previous.sessionId ?? previous.id) : id;
      const finishing = [...live.values()].find((r) => r.sessionId === sessionId && r.closing);
      if (finishing) await finishing.done;
      if (sessions.has(sessionId) || [...live.values()].some((r) => r.sessionId === sessionId))
        throw new HttpError(409, 'session_busy', '原会话仍有运行，不能同时修改同一工作目录');
      sessions.add(sessionId);
      try {
        const inserted = await repo.insert(
          {
            id,
            payerId: body.payerId,
            taskId: body.taskId ?? null,
            nodeId: body.nodeId ?? null,
            model: body.model,
            prompt: body.prompt,
            inputsFrom:
              body.inputsFrom.length === 0 && previous ? previous.inputsFrom : body.inputsFrom,
            sessionId,
            continueFrom: previous?.id ?? null,
          },
          { body },
        );
        const row = await owned(id);
        if (!inserted) {
          // 同一个运行 ID 重复提交：参数一致就当作幂等重试，原样返回
          if (row.payerId !== body.payerId || row.model !== body.model) {
            throw new HttpError(409, 'run_id_conflict', '这个运行 ID 已经被别的运行用了');
          }
          return ctx.bodyOf(row);
        }
        const run = newLiveRun(await repo.nextSequence(id), sessionId);
        live.set(id, run);
        const inputs = body.inputs.map((f) => ({
          path: f.path,
          content: Buffer.from(f.contentBase64, 'base64'),
        }));
        run.done = ctx
          .execute(
            row,
            inputs,
            body.materials ?? [],
            run,
            {
              goal: body.goal ?? false,
              ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
              ...(body.steps ? { steps: body.steps } : {}),
            },
            catalog,
          )
          .catch((err: unknown) => logger.error({ err, runId: id }, '运行收尾失败'));
        // 刚登记、还没结束的运行谈不上「接着做」
        return toRunBody(row, false);
      } finally {
        sessions.delete(sessionId);
      }
    },

    get: async (id: string) => ctx.bodyOf(await owned(id)),

    environment: async () => {
      if (!executor.environment)
        throw new HttpError(503, 'environment_unavailable', '执行环境尚未提供探测结果');
      return executor.environment();
    },

    /**
     * 任务被删除（ADR 0012 §15 真删除）：删掉它已结束的运行的产出包、检查报告、运行记录和持久工作目录。
     * 还没结束的运行（正常不会有）先留着，返回 false，事件重投时再删。
     */
    async purgeTask(taskId: string): Promise<boolean> {
      const rows = await repo.listByTask(taskId);
      const ended = rows.filter((row) => !['queued', 'starting', 'running'].includes(row.status));
      for (const row of ended) {
        if (row.outputKey) await store.delete(row.outputKey);
        for (const kind of ['audio', 'video', 'application'])
          await store.delete(`runs/${row.id}/${kind}-check.json`);
      }
      if (ended.length === rows.length)
        for (const sessionId of new Set(ended.map((r) => r.sessionId ?? r.id)))
          if (!(await repo.listBySession(sessionId)).some((r) => r.taskId !== taskId))
            await executor.purgeWorkspace(sessionId);
      await repo.removeMany(ended.map((row) => row.id));
      if (ended.length) logger.info({ taskId, runs: ended.length }, '任务已删除，运行存档一并清理');
      return ended.length === rows.length;
    },

    /** 用户在运行中追问：排在当前这一轮之后处理。运行没在进行时 409。 */
    async message(id: string, text: string): Promise<void> {
      await owned(id);
      const run = live.get(id);
      if (!run?.agent || run.closing || run.abort.signal.aborted) {
        throw new HttpError(409, 'run_not_active', '这次运行已经结束或还没开始，不能追问');
      }
      run.prompts += 1;
      await run.agent.prompt(text);
    },

    ...createOutputs(ctx),
    ...control,
  };
}

export type RunService = ReturnType<typeof createRunService>;
