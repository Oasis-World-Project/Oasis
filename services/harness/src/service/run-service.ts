// 对话里主 AI 的一轮 = 一次运行。完整生命周期：
// 排队 → 找这份会话干活的地方：空着的 dsh 接着用，没有就签发临时 Key、起沙箱（挂上这个会话的持久工作
// 目录）、放入说明、dsh 握手、接着原会话 → 交用户的话 → 记录事件 → 等这一轮做完（期间可插话）
// → 记下 out/ 的清单 → 写结局。做完的沙箱和 dsh 留一会儿等下一轮（run/hosts.ts）。
// 工作目录和 dsh 会话在持久卷里，沙箱销毁后还在：下一轮用 continueFrom 接着原会话做，AI 记得之前的事。
// 产出的文件留在工作目录里，这一轮上只记清单；画布登记成果时从工作目录现取（run/outputs.ts）。
// 持久卷不在了就接不上（409 workspace_unavailable），由调用方开新会话。
// 这里是对外接口和登记新运行；执行、搬文件、停止与接管、读产出分别在 run/ 下。
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type RunBody,
  SESSION_VERSION_GONE,
  type StartRunBody,
  WORKSPACE_UNAVAILABLE,
} from '@oasis/contracts/harness';
import { HttpError, packStreams } from '@oasis/service-kit';
import type { Run } from '../repo/runs-repo.ts';
import { createControl } from './run/control.ts';
import { createExecution } from './run/execute.ts';
import { createOutputs } from './run/outputs.ts';
import {
  createGate,
  newLiveRun,
  personOf,
  requestOf,
  type RunContext,
  type RunDeps,
  toRunBody,
} from './run/shared.ts';
import { createHosts } from './run/hosts.ts';
import { createStorage } from './run/storage.ts';

export function createRunService(deps: RunDeps) {
  const { repo, store, logger } = deps;
  const state: RunContext['state'] = {
    live: new Map(),
    sessions: new Set(),
    controlRequests: new Map(),
    controlWrites: new Map(),
    closing: false,
    gate: createGate(deps.maxConcurrent),
  };
  /** 各份会话干活的地方（沙箱和里面的 dsh）：一轮做完留着等下一轮 */
  const hosts = createHosts(deps);
  async function owned(id: string): Promise<Run> {
    const row = await repo.get(id);
    if (!row) throw new HttpError(404, 'run_not_found', '没有这次运行');
    return row;
  }
  const executorOf: RunContext['executorOf'] = ({ workplace, ...run }) => {
    if (workplace?.kind !== 'device') return deps.executor;
    if (!deps.devices) throw new HttpError(503, 'devices_unavailable', '这里不能在用户电脑上干活');
    return deps.devices.executor(personOf(run), workplace);
  };
  const ctx = {
    deps,
    state,
    owned,
    executorOf,
    // 会话在用户电脑上的：那台电脑这会儿可能没连上，先当它还在，下一轮开始时再问那台电脑
    bodyOf: async (row: Run) =>
      toRunBody(
        row,
        Boolean(row.workplace) || (await deps.executor.workspaceExists(row.sessionId ?? row.id)),
      ),
  } as RunContext;
  Object.assign(ctx, createStorage(ctx), createExecution(ctx, hosts));
  const control = createControl(ctx, hosts);
  ctx.recover = control.recover;
  const { live, sessions } = state;

  /** 接着之前的运行：同一付费人、同一对话、已结束、同一个地方、持久工作目录还在、会话没有更新的运行 */
  async function continuable(body: StartRunBody, runId: string): Promise<Run> {
    // 刚点了停止马上发下一句：那一轮还在收尾（停沙箱、存产出），等它真正停好再接着，
    // 不能当成「还没结束」拒掉（2026-11-08 回归测试发现过）
    const stopping = live.get(runId);
    if (stopping?.abort.signal.aborted) await stopping.done;
    const previous = await repo.get(runId);
    const ended = ['succeeded', 'failed', 'cancelled', 'stopped'].includes(previous?.status ?? '');
    if (!previous || previous.conversationId !== body.conversationId || !ended)
      throw new HttpError(409, 'continue_unavailable', '要接着的那一轮不存在或还没结束');
    const session = previous.sessionId ?? previous.id;
    // 换了地方（云端和电脑、换了电脑或文件夹）：会话在原来那边，接不上
    const workplace = requestOf(body).workplace;
    if (!isDeepStrictEqual(previous.workplace ?? { kind: 'cloud' }, workplace))
      throw new HttpError(409, WORKSPACE_UNAVAILABLE, '换了干活的地方，接不上原会话');
    // 工作目录不在了就没有会话，不能冒充接着原会话做
    if (!(await executorOf(previous).workspaceExists(session)))
      throw new HttpError(409, WORKSPACE_UNAVAILABLE, '原会话的工作目录已经不在了，接不上原会话');
    const history = await repo.listBySession(session);
    if (history.some((r) => r.id !== previous.id && r.createdAt > previous.createdAt))
      throw new HttpError(409, 'session_advanced', '该会话已有后续运行，请从最新进度继续');
    return previous;
  }

  /** 清掉一份会话：空着留用的 dsh 先收掉，再删它的持久工作目录（在用户电脑上而电脑没连上的留在那边） */
  async function purgeSession(row: Run): Promise<void> {
    const sessionId = row.sessionId ?? row.id;
    await hosts.drop(sessionId);
    await executorOf(row)
      .purgeWorkspace(sessionId)
      .catch((err: unknown) => {
        if (!row.workplace) throw err;
        logger.warn({ err, sessionId }, '用户电脑没连上，那边的会话没删');
      });
  }

  return {
    async start(body: StartRunBody & Required<Pick<StartRunBody, 'materials'>>): Promise<RunBody> {
      const request = requestOf(body);
      const { workplace } = request;
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
      // 目录未就绪、用户的电脑没连上属于准入等待，不登记失败运行
      const catalog = await ctx.admit(
        executorOf({ payerId: body.payerId, actorId: body.actorId ?? null, workplace }),
        body.model,
        request.domesticOnly,
      );
      const previous = body.continueFrom ? await continuable(body, body.continueFrom) : undefined;
      const id = body.runId ?? randomUUID();
      const sessionId = previous ? (previous.sessionId ?? previous.id) : id;
      const finishing = [...live.values()].find((r) => r.sessionId === sessionId && r.closing);
      if (finishing) await finishing.done;
      if (sessions.has(sessionId) || [...live.values()].some((r) => r.sessionId === sessionId))
        throw new HttpError(409, 'session_busy', '这个会话还有一轮没做完，不能同时开两轮');
      sessions.add(sessionId);
      try {
        const inserted = await repo.insert(
          {
            id,
            payerId: body.payerId,
            actorId: body.actorId ?? null,
            conversationId: body.conversationId,
            model: body.model,
            prompt: body.prompt,
            sessionId,
            continueFrom: previous?.id ?? null,
            workplace: workplace.kind === 'device' ? workplace : null,
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
        run.done = ctx
          .execute(row, request, run, catalog)
          .catch((err: unknown) => logger.error({ err, runId: id }, '运行收尾失败'));
        // 刚登记、还没结束的运行谈不上「接着做」
        return toRunBody(row, false);
      } finally {
        sessions.delete(sessionId);
      }
    },

    get: async (id: string) => ctx.bodyOf(await owned(id)),

    environment: async () => {
      if (!deps.executor.environment)
        throw new HttpError(503, 'environment_unavailable', '执行环境尚未提供探测结果');
      return deps.executor.environment();
    },

    /**
     * 删对话、开新话题（用户删除就是真删除）：删掉这个对话已结束的运行记录和持久工作目录。
     * 还有没结束的运行时什么都不删，返回 false（调用方先停下那一轮再删）。会话在用户电脑上而那台电脑
     * 没连上的，留在那台电脑上（记一条日志），其余照删。
     */
    async purgeConversation(conversationId: string): Promise<boolean> {
      const rows = await repo.listByConversation(conversationId);
      if (rows.some((row) => ['queued', 'starting', 'running'].includes(row.status))) return false;
      // 2026-11-26 以前的一轮在对象存储里有一份产出包，一起删
      for (const row of rows) if (row.outputKey) await store.delete(row.outputKey);
      const bySession = new Map(rows.map((r) => [r.sessionId ?? r.id, r]));
      for (const row of bySession.values()) await purgeSession(row);
      await repo.removeMany(rows.map((row) => row.id));
      if (rows.length)
        logger.info({ conversationId, runs: rows.length }, '对话的运行和工作目录已清理');
      return true;
    },

    /**
     * 撤回这份会话最近的一轮（用户编辑、删除了引出它的那句话）：下一轮新起 dsh 之前把它接着的那一轮
     * 结束时存的会话记录放回去，AI 就不记得这一轮了；这一轮的记录删掉，已经改的文件不动。
     */
    async undo(id: string, conversationId: string): Promise<{ continueFrom: string | null }> {
      await live.get(id)?.done;
      const row = await owned(id);
      if (row.conversationId !== conversationId)
        throw new HttpError(404, 'run_not_found', '运行不存在');
      if (['queued', 'starting', 'running'].includes(row.status))
        throw new HttpError(409, 'run_active', '这一轮还没结束，先停下再撤回');
      const session = row.sessionId ?? row.id;
      const history = await repo.listBySession(session);
      if (history.some((r) => r.id !== row.id && r.createdAt > row.createdAt))
        throw new HttpError(409, 'session_advanced', '只能撤回这份会话最近的一轮');
      if (row.continueFrom && !(await repo.hasVersion(row.continueFrom)))
        throw new HttpError(409, SESSION_VERSION_GONE, '这一轮之前的会话记录没有存下来，退不回去');
      if (row.continueFrom) {
        // 空着留用的 dsh 手里是这一轮之后的会话：收掉，下一轮新起
        await hosts.drop(session);
        await repo.setRestore(row.continueFrom, true);
      } else {
        // 这份会话的第一轮：退回去就是什么都不记得，整份会话清掉，下一轮开新会话
        await purgeSession(row);
      }
      if (row.outputKey) await store.delete(row.outputKey);
      await repo.removeMany([row.id]);
      logger.info({ runId: id, continueFrom: row.continueFrom }, '撤回了一轮');
      return { continueFrom: row.continueFrom };
    },

    /**
     * 用户在这一轮进行中插话：在 AI 的下一步送到。AI 还没开始（排队、起沙箱、装 dsh）时先存着，
     * 开头那句交出去后按顺序送。这一轮已经在收尾或结束时 409。
     */
    async message(id: string, text: string): Promise<void> {
      await owned(id);
      const run = live.get(id);
      if (!run || run.closing || run.abort.signal.aborted) {
        throw new HttpError(409, 'run_not_active', '这一轮已经在收尾或结束了，不能插话');
      }
      if (!run.agent) {
        run.queued.push(text);
        return;
      }
      run.prompts += 1;
      await run.agent.prompt(text);
    },

    /**
     * 一轮进行中往它的工作目录里再放文件（群里别的 AI 刚交的群文件）。
     * 这一轮不在这个进程里跑、在收尾、沙箱还没起来或不支持时 409。
     */
    async addMaterials(id: string, materials: Required<StartRunBody>['materials']): Promise<void> {
      const row = await owned(id);
      const run = live.get(id);
      if (!run?.put || run.closing || run.abort.signal.aborted)
        throw new HttpError(409, 'run_not_active', '这一轮现在放不进文件');
      await run.put(packStreams(await ctx.materialFiles(materials, id, personOf(row))));
    },

    ...createOutputs(ctx),
    ...control,
  };
}

export type RunService = ReturnType<typeof createRunService>;
