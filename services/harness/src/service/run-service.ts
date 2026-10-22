// 一次 agent 运行的完整生命周期：
// 排队 → 签发临时 Key → 起沙箱、放入输入 → dsh 握手、交任务 → 记录事件 → 等空闲（期间可追问）
// → 取出产出和会话存档存进对象存储 → 销毁沙箱、作废 Key → 写结局并发出 harness.run.finished。
// 用户「停止」时不等 dsh 说完：直接从还在跑的沙箱里取出产出和会话存档，再销毁沙箱；
// 之后用 continueFrom 接着这次运行，AI 记得停下之前做到哪了（ADR 0004 §4）。
import { randomUUID } from 'node:crypto';
import { RunFinished } from '@oasis/contracts/events';
import type { RunBody, RunEventBody, RunTextsBody, StartRunBody } from '@oasis/contracts/harness';
import { RunKeyCreated } from '@oasis/contracts/model-gateway';
import { createEnvelope, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import {
  connectAgent,
  isSessionLock,
  SANDBOX_PATHS,
  sandboxEnv,
  type AgentConnection,
} from '../adapter/dsh.ts';
import type { Executor, Sandbox } from '../executor/executor.ts';
import { extractFiles, listFiles, packFiles, readLimited } from '../executor/tar.ts';
import type { ObjectStore } from '../repo/object-store.ts';
import type { Run, RunOutcome, RunsRepo } from '../repo/runs-repo.ts';

type Status = RunBody['status'];

/** 关卡检查时读得懂的文字类产出 */
const TEXT_FILE =
  /\.(md|markdown|txt|html?|css|js|mjs|ts|tsx|jsx|json|csv|tsv|xml|ya?ml|py|sql|svg)$/i;

/** 放进 out/ 的占位文件：保证目录存在且属于沙箱用户，不算产出 */
const KEEP_FILE = '.oasis-keep';

interface LiveRun {
  readonly abort: AbortController;
  agent?: AgentConnection;
  /** 已交给 dsh 的用户消息条数（含最初的任务说明） */
  prompts: number;
  /** 已经开始收尾，不再接受追问 */
  closing: boolean;
  nextSeq: number;
  /** AI 最近说的一句话，结束时作为 summary */
  lastText?: string;
  /** 事件按顺序写库 */
  writes: Promise<void>;
  /** 被停止时从沙箱里取出的产出和会话存档 */
  saved?: Promise<Saved>;
  done: Promise<void>;
}

interface Saved {
  outputs?: { key: string; files: { path: string; size: number }[] };
  session?: { key: string; files: { path: string; size: number }[] };
}

/** 取消、停止、超时、服务关闭时中止运行的原因 */
class StopRun extends Error {
  readonly status: Status;
  constructor(status: Status, message: string) {
    super(message);
    this.status = status;
  }
}

/** 存下来的产出和会话 → 运行结局里的字段 */
const savedOutcome = (saved: Saved) => ({
  outputs: saved.outputs?.files.filter((f) => f.path !== KEEP_FILE) ?? [],
  outputKey: saved.outputs?.key ?? null,
  sessionKey: saved.session?.key ?? null,
});

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
    summary: run.summary,
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
    if (kind === 'assistant_text') run.lastText = String(data.text);
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

  /** 取出产出和会话存档（会话存档失败不影响结果） */
  async function save(sandbox: Sandbox, id: string): Promise<Saved> {
    const outputs = await archive(sandbox, SANDBOX_PATHS.outputs, `runs/${id}/outputs.tar`);
    const session = await archive(sandbox, SANDBOX_PATHS.sessions, `runs/${id}/session.tar`).catch(
      (err: unknown) => {
        logger.warn({ err, runId: id }, '会话存档失败（不影响运行结果）');
        return undefined;
      },
    );
    return { outputs, session };
  }

  /** 上游运行的产出：解出来放到 in/<as>/ 下 */
  async function upstreamFiles(row: Run) {
    const files: { path: string; content: Buffer }[] = [];
    for (const ref of row.inputsFrom) {
      const upstream = await repo.get(ref.runId);
      if (!upstream?.outputKey) continue;
      for (const file of await extractFiles(await store.get(upstream.outputKey))) {
        if (file.path !== KEEP_FILE)
          files.push({ path: `in/${ref.as}/${file.path}`, content: file.content });
      }
    }
    return files;
  }

  /**
   * 接着之前某次运行时要放回沙箱的东西：它的产出放回 out/，它的会话存档放回 dsh 的 sessions/
   * （去掉锁文件，否则恢复时会以为会话还被占着）。
   */
  async function continuation(row: Run) {
    const previous = row.continueFrom ? await repo.get(row.continueFrom) : undefined;
    if (!previous) return { workspace: [], dshHome: [] };
    const workspace = previous.outputKey
      ? (await extractFiles(await store.get(previous.outputKey)))
          .filter((f) => f.path !== KEEP_FILE)
          .map((f) => ({ path: `out/${f.path}`, content: f.content }))
      : [];
    const dshHome = previous.sessionKey
      ? (await extractFiles(await store.get(previous.sessionKey)))
          .filter((f) => !isSessionLock(f.path))
          .map((f) => ({ path: `sessions/${f.path}`, content: f.content }))
      : [];
    return { workspace, dshHome };
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
      summary: null,
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

      const restored = await continuation(row);
      const files = [
        ...inputs.map((f) => ({ path: `in/${f.path}`, content: f.content })),
        ...(await upstreamFiles(row)),
        ...restored.workspace,
        // 保证 out/ 目录存在且属于沙箱用户
        { path: `out/${KEEP_FILE}`, content: Buffer.alloc(0) },
      ];
      sandbox = await executor.start({
        runId: id,
        env: sandboxEnv({ modelBaseUrl: deps.modelBaseUrl, runKey: key.key, model: row.model }),
        files: [
          { dir: SANDBOX_PATHS.workdir, tar: await packFiles(files) },
          ...(restored.dshHome.length > 0
            ? [{ dir: SANDBOX_PATHS.dshHome, tar: await packFiles(restored.dshHome) }]
            : []),
        ],
      });
      const box = sandbox;
      run.abort.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = run.abort.signal.reason;
          if (reason instanceof StopRun && reason.status === 'stopped') {
            // 停止：先把已经做出来的东西存下来，再销毁沙箱
            run.saved = save(box, id).finally(() => void box.destroy());
          } else {
            void box.destroy();
          }
        },
        { once: true },
      );
      // 沙箱启动期间就被取消或停止了：上面的监听来不及收到，这里补上（finally 会销毁沙箱）
      stopped();
      await repo.update(id, { containerId: sandbox.id, status: 'running', startedAt: new Date() });

      let stderrTail = '';
      sandbox.stderr.setEncoding('utf8');
      sandbox.stderr.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-2000);
      });

      const agent = connectAgent({
        stdin: sandbox.stdin,
        stdout: sandbox.stdout,
        sessionId: row.sessionId ?? id,
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
      if (row.continueFrom) await agent.resume();
      run.prompts += 1;
      await agent.prompt(row.prompt);
      // 任务说明交出去之后才接受追问，保证追问排在任务说明后面
      run.agent = agent;
      const failure = await settle(run, agent);
      stopped();

      const saved = await save(sandbox, id);
      await agent.shutdown().catch(() => undefined);
      Object.assign(outcome, {
        status: failure ? 'failed' : 'succeeded',
        error: failure ?? null,
        ...savedOutcome(saved),
      });
    } catch (err) {
      const stop = err instanceof StopRun ? err : run.abort.signal.reason;
      if (stop instanceof StopRun) {
        Object.assign(outcome, { status: stop.status, error: stop.message });
        if (run.saved) {
          const saved = await run.saved.catch((saveErr: unknown) => {
            logger.warn({ err: saveErr, runId: id }, '停止时保存产出失败');
            return {};
          });
          Object.assign(outcome, savedOutcome(saved));
        }
      } else {
        logger.error({ err, runId: id }, '运行失败');
        outcome.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timer);
      run.closing = true;
      outcome.summary = run.lastText ?? null;
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
    const status = outcome.status as 'succeeded' | 'failed' | 'cancelled' | 'stopped';
    const event = createEnvelope(deps.serviceName, RunFinished.type, {
      runId: row.id,
      payerId: row.payerId,
      taskId: row.taskId,
      nodeId: row.nodeId,
      status,
      error: outcome.error,
      outputs: outcome.outputs,
      summary: outcome.summary,
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
      body: StartRunBody & Required<Pick<StartRunBody, 'inputs' | 'inputsFrom'>>,
    ): Promise<RunBody> {
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
      // 接着之前的运行：同一付费人、已结束、留下了会话存档；没另给输入就沿用它的输入
      let previous: Run | undefined;
      if (body.continueFrom) {
        previous = await repo.get(body.continueFrom);
        const ended = ['succeeded', 'failed', 'cancelled', 'stopped'].includes(
          previous?.status ?? '',
        );
        if (previous?.payerId !== body.payerId || !ended || !previous.sessionKey) {
          throw new HttpError(
            409,
            'continue_unavailable',
            '要接着的那次运行不存在、还没结束或没有会话存档',
          );
        }
      }
      const id = body.runId ?? randomUUID();
      const inserted = await repo.insert({
        id,
        payerId: body.payerId,
        taskId: body.taskId ?? null,
        nodeId: body.nodeId ?? null,
        model: body.model,
        prompt: body.prompt,
        inputsFrom:
          body.inputsFrom.length === 0 && previous ? previous.inputsFrom : body.inputsFrom,
        sessionId: previous ? (previous.sessionId ?? previous.id) : id,
        continueFrom: previous?.id ?? null,
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

    /** 文字类产出（给关卡检查用）：按路径顺序读，总长超过 maxChars 就截断 */
    async texts(id: string, maxChars: number): Promise<RunTextsBody> {
      const row = await owned(id);
      const files: RunTextsBody['files'] = [];
      if (!row.outputKey) return { files, truncated: false };
      let left = maxChars;
      let truncated = false;
      for (const file of await extractFiles(await store.get(row.outputKey))) {
        if (file.path === KEEP_FILE || !TEXT_FILE.test(file.path) || file.content.includes(0))
          continue;
        if (left <= 0) {
          truncated = true;
          break;
        }
        let text = file.content.toString('utf8');
        if (text.length > left) {
          text = text.slice(0, left);
          truncated = true;
        }
        left -= text.length;
        files.push({ path: file.path, text });
      }
      return { files, truncated };
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

    /**
     * 停止：排队中的不再开始；运行中的先存下产出和会话再销毁沙箱，之后可以接着做。
     * 已经在收尾（马上就成功了）或已结束的不受影响，不报错。
     */
    async stop(id: string): Promise<void> {
      await owned(id);
      const run = live.get(id);
      if (run && !run.closing) run.abort.abort(new StopRun('stopped', '已停止'));
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
          summary: null,
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
