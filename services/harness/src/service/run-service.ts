// 一次 agent 运行的完整生命周期：
// 排队 → 签发临时 Key → 起沙箱、放入输入 → dsh 握手、交任务 → 记录事件 → 等空闲（期间可追问）
// → 取出产出和会话存档存进对象存储 → 销毁沙箱、作废 Key → 写结局并发出 harness.run.finished。
import { randomUUID } from 'node:crypto';
import { RunFinished } from '@oasis/contracts/events';
import type { RunBody, RunEventBody, StartRunBody } from '@oasis/contracts/harness';
import { RunKeyCreated } from '@oasis/contracts/model-gateway';
import { createEnvelope, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import { connectAgent, SANDBOX_PATHS, sandboxEnv, type AgentConnection } from '../adapter/dsh.ts';
import type { Executor, Sandbox } from '../executor/executor.ts';
import { listFiles, packFiles, readLimited } from '../executor/tar.ts';
import type { ObjectStore } from '../repo/object-store.ts';
import type { Run, RunOutcome, RunsRepo } from '../repo/runs-repo.ts';

type Status = RunBody['status'];

interface LiveRun {
  readonly abort: AbortController;
  agent?: AgentConnection;
  /** 已交给 dsh 的用户消息条数（含最初的任务说明） */
  prompts: number;
  /** 已经开始收尾，不再接受追问 */
  closing: boolean;
  nextSeq: number;
  /** 事件按顺序写库 */
  writes: Promise<void>;
  done: Promise<void>;
}

/** 取消、超时、服务关闭时中止运行的原因 */
class StopRun extends Error {
  readonly status: Status;
  constructor(status: Status, message: string) {
    super(message);
    this.status = status;
  }
}

function toRunBody(run: Run): RunBody {
  return {
    id: run.id,
    payerId: run.payerId,
    taskId: run.taskId,
    nodeId: run.nodeId,
    model: run.model,
    status: run.status,
    error: run.error,
    outputs: run.outputs,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** 简单的并发闸门：同时最多 limit 个运行在用沙箱，其余排队。 */
function createGate(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async acquire(): Promise<() => void> {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
      return () => {
        active -= 1;
        waiting.shift()?.();
      };
    },
  };
}

export function createRunService(deps: {
  repo: RunsRepo;
  executor: Executor;
  store: ObjectStore;
  modelGateway: ServiceClient;
  modelBaseUrl: string;
  maxConcurrent: number;
  timeoutMs: number;
  outputMaxBytes: number;
  serviceName: string;
  logger: Logger;
}) {
  const { repo, executor, store, logger } = deps;
  const live = new Map<string, LiveRun>();
  const gate = createGate(deps.maxConcurrent);

  function record(
    runId: string,
    run: LiveRun,
    kind: RunEventBody['kind'],
    data: Record<string, unknown>,
  ) {
    const seq = run.nextSeq++;
    run.writes = run.writes
      .then(() => repo.appendEvents(runId, [{ seq, kind, data }]))
      .catch((err: unknown) => logger.error({ err, runId, seq }, '写运行事件失败'));
  }

  /** 等 dsh 空闲；等待期间又收到追问就接着等，直到没有新消息。 */
  async function settle(run: LiveRun, agent: AgentConnection): Promise<string | undefined> {
    let failure: string | undefined;
    let seen: number;
    do {
      seen = run.prompts;
      failure = await agent.waitIdle();
    } while (run.prompts !== seen && !run.abort.signal.aborted);
    run.closing = true;
    return failure;
  }

  /** 把沙箱里的目录打包存进对象存储；目录不存在或为空时返回 undefined */
  async function archive(sandbox: Sandbox, path: string, key: string) {
    const stream = await sandbox.readArchive(path);
    if (!stream) return undefined;
    const tar = await readLimited(stream, deps.outputMaxBytes);
    const files = await listFiles(tar);
    if (files.length === 0) return undefined;
    await store.put(key, tar, 'application/x-tar');
    return { key, files };
  }

  async function execute(row: Run, inputs: { path: string; content: Buffer }[], run: LiveRun) {
    const { id } = row;
    const release = await gate.acquire();
    let sandbox: Sandbox | undefined;
    let keyId: string | undefined;
    const timer = setTimeout(
      () =>
        run.abort.abort(
          new StopRun('failed', `运行超时（${Math.round(deps.timeoutMs / 60_000)} 分钟）`),
        ),
      deps.timeoutMs,
    );
    const outcome: Omit<RunOutcome, 'finishedAt'> = {
      status: 'failed',
      error: null,
      outputs: [],
      outputKey: null,
      sessionKey: null,
    };
    try {
      const stopped = () => {
        const reason: unknown = run.abort.signal.reason;
        if (run.abort.signal.aborted)
          throw reason instanceof StopRun ? reason : new StopRun('cancelled', '已取消');
      };
      stopped();
      await repo.update(id, { status: 'starting' });

      const key = await deps.modelGateway.json('POST', '/internal/run-keys', {
        body: {
          runId: id,
          payerId: row.payerId,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.nodeId ? { nodeId: row.nodeId } : {}),
          ttlSeconds: Math.ceil(deps.timeoutMs / 1000) + 600,
        },
        requestId: id,
        schema: RunKeyCreated,
      });
      keyId = key.keyId;
      await repo.update(id, { runKeyId: keyId });
      stopped();

      const files = [
        ...inputs.map((f) => ({ path: `in/${f.path}`, content: f.content })),
        // 保证 out/ 目录存在且属于沙箱用户
        { path: 'out/.oasis-keep', content: Buffer.alloc(0) },
      ];
      sandbox = await executor.start({
        runId: id,
        env: sandboxEnv({ modelBaseUrl: deps.modelBaseUrl, runKey: key.key, model: row.model }),
        files: [{ dir: SANDBOX_PATHS.workdir, tar: await packFiles(files) }],
      });
      const box = sandbox;
      run.abort.signal.addEventListener('abort', () => void box.destroy(), { once: true });
      await repo.update(id, { containerId: sandbox.id, status: 'running', startedAt: new Date() });

      let stderrTail = '';
      sandbox.stderr.setEncoding('utf8');
      sandbox.stderr.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-2000);
      });

      const agent = connectAgent({
        stdin: sandbox.stdin,
        stdout: sandbox.stdout,
        sessionId: id,
        onEvent: (event) => record(id, run, event.kind, event.data),
      });
      run.abort.signal.addEventListener('abort', () => agent.abort(new Error('运行已中止')), {
        once: true,
      });
      try {
        await agent.initialize(row.model, SANDBOX_PATHS.workdir);
      } catch (err) {
        stopped();
        throw new Error(`dsh 启动失败：${String(err)}；stderr：${stderrTail}`, { cause: err });
      }
      run.prompts += 1;
      await agent.prompt(row.prompt);
      // 任务说明交出去之后才接受追问，保证追问排在任务说明后面
      run.agent = agent;
      const failure = await settle(run, agent);
      stopped();

      const outputs = await archive(sandbox, SANDBOX_PATHS.outputs, `runs/${id}/outputs.tar`);
      const session = await archive(
        sandbox,
        SANDBOX_PATHS.sessions,
        `runs/${id}/session.tar`,
      ).catch((err: unknown) => {
        logger.warn({ err, runId: id }, '会话存档失败（不影响运行结果）');
        return undefined;
      });
      await agent.shutdown().catch(() => undefined);
      Object.assign(outcome, {
        status: failure ? 'failed' : 'succeeded',
        error: failure ?? null,
        outputs: outputs?.files.filter((f) => f.path !== '.oasis-keep') ?? [],
        outputKey: outputs?.key ?? null,
        sessionKey: session?.key ?? null,
      });
    } catch (err) {
      const stop = err instanceof StopRun ? err : run.abort.signal.reason;
      if (stop instanceof StopRun) {
        Object.assign(outcome, { status: stop.status, error: stop.message });
      } else {
        logger.error({ err, runId: id }, '运行失败');
        outcome.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timer);
      run.closing = true;
      await sandbox
        ?.destroy()
        .catch((err: unknown) => logger.warn({ err, runId: id }, '销毁沙箱失败'));
      if (keyId) {
        await deps.modelGateway
          .json('POST', `/internal/run-keys/${keyId}/revoke`, { body: {}, requestId: id })
          .catch((err: unknown) => logger.warn({ err, runId: id }, '作废临时 Key 失败，等它过期'));
      }
      release();
    }
    await run.writes;
    await finish(row, outcome);
    live.delete(id);
  }

  async function finish(row: Run, outcome: Omit<RunOutcome, 'finishedAt'>) {
    const finishedAt = new Date();
    const status = outcome.status as 'succeeded' | 'failed' | 'cancelled';
    const event = createEnvelope(deps.serviceName, RunFinished.type, {
      runId: row.id,
      payerId: row.payerId,
      taskId: row.taskId,
      nodeId: row.nodeId,
      status,
      error: outcome.error,
      outputs: outcome.outputs,
      finishedAt: finishedAt.toISOString(),
    });
    await repo.finish(row.id, { ...outcome, finishedAt }, event);
    logger.info({ runId: row.id, status, outputs: outcome.outputs.length }, '运行结束');
  }

  async function owned(id: string): Promise<Run> {
    const row = await repo.get(id);
    if (!row) throw new HttpError(404, 'run_not_found', '没有这次运行');
    return row;
  }

  return {
    async start(
      body: StartRunBody & { inputs: NonNullable<StartRunBody['inputs']> },
    ): Promise<RunBody> {
      const id = body.runId ?? randomUUID();
      const inserted = await repo.insert({
        id,
        payerId: body.payerId,
        taskId: body.taskId ?? null,
        nodeId: body.nodeId ?? null,
        model: body.model,
        prompt: body.prompt,
      });
      const row = await owned(id);
      if (!inserted) {
        // 同一个运行 ID 重复提交：参数一致就当作幂等重试，原样返回
        if (row.payerId !== body.payerId || row.model !== body.model) {
          throw new HttpError(409, 'run_id_conflict', '这个运行 ID 已经被别的运行用了');
        }
        return toRunBody(row);
      }
      const run: LiveRun = {
        abort: new AbortController(),
        prompts: 0,
        closing: false,
        nextSeq: 0,
        writes: Promise.resolve(),
        done: Promise.resolve(),
      };
      live.set(id, run);
      const inputs = body.inputs.map((f) => ({
        path: f.path,
        content: Buffer.from(f.contentBase64, 'base64'),
      }));
      run.done = execute(row, inputs, run).catch((err: unknown) =>
        logger.error({ err, runId: id }, '运行收尾失败'),
      );
      return toRunBody(row);
    },

    get: async (id: string) => toRunBody(await owned(id)),

    async events(id: string, afterSeq: number, limit: number): Promise<RunEventBody[]> {
      await owned(id);
      const rows = await repo.listEvents(id, afterSeq, limit);
      return rows.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        data: e.data,
        createdAt: e.createdAt.toISOString(),
      }));
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

    /** 取消：排队中的不再开始，运行中的立即销毁沙箱。已结束的取消不报错。 */
    async cancel(id: string): Promise<void> {
      await owned(id);
      live.get(id)?.abort.abort(new StopRun('cancelled', '已取消'));
    },

    /**
     * 启动时调用：上次进程留下的未结束运行一律记为失败（沙箱里的状态已无法接回），
     * 并清理遗留的沙箱容器。单实例部署的前提见 ADR 0003。
     */
    async recover(): Promise<void> {
      for (const row of await repo.listUnfinished()) {
        if (live.has(row.id)) continue;
        await finish(row, {
          status: 'failed',
          error: '运行中断：harness 重启',
          outputs: [],
          outputKey: null,
          sessionKey: null,
        });
        if (row.runKeyId) {
          await deps.modelGateway
            .json('POST', `/internal/run-keys/${row.runKeyId}/revoke`, {
              body: {},
              requestId: row.id,
            })
            .catch(() => undefined);
        }
      }
      const removed = await executor.removeOrphans(new Set(live.keys()));
      if (removed > 0) logger.info({ removed }, '清理了遗留的沙箱容器');
    },

    /** 服务关闭：中止所有进行中的运行并等它们收尾。 */
    async stopAll(): Promise<void> {
      const runs = [...live.values()];
      for (const run of runs) run.abort.abort(new StopRun('failed', '运行中断：harness 关闭'));
      await Promise.all(runs.map((run) => run.done));
    },
  };
}

export type RunService = ReturnType<typeof createRunService>;
