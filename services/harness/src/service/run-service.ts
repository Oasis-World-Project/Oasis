// 一次 agent 运行的完整生命周期：
// 排队 → 签发临时 Key → 起沙箱、放入输入 → dsh 握手、交任务 → 记录事件 → 等空闲（期间可追问）
// → 取出产出和会话存档存进对象存储 → 销毁沙箱、作废 Key → 写结局并发出 harness.run.finished。
// 用户「停止」时不等 dsh 说完：直接从还在跑的沙箱里取出产出和会话存档，再销毁沙箱；
// 之后用 continueFrom 接着这次运行，AI 记得停下之前做到哪了（ADR 0004 §4）。
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import { RunFinished } from '@oasis/contracts/events';
import {
  AudioCheckResult,
  VideoCheckResult,
  type RunBody,
  type RunEventBody,
  type RunTextsBody,
  type StartRunBody,
  StartRunBody as StartRunSchema,
  type ExecutionEnvironment,
} from '@oasis/contracts/harness';
import {
  ExecutionModels,
  RunKeyCreated,
  type ModelCapabilities,
} from '@oasis/contracts/model-gateway';
import {
  contentTypeOf,
  createEnvelope,
  HttpError,
  type Logger,
  type ObjectStore,
  type ServiceClient,
} from '@oasis/service-kit';
import {
  connectAgent,
  isSessionLock,
  isSessionArchive,
  SANDBOX_PATHS,
  sandboxEnv,
  runtimeFiles,
  type SandboxPackages,
  type AgentConnection,
} from '../adapter/dsh.ts';
import { startRunLease } from './run-lease.ts';
import type { Executor, Sandbox } from '../executor/executor.ts';
import {
  archiveFile,
  extractFiles,
  packFiles,
  packStreams,
  readLimited,
  rewriteArchive,
  scanArchive,
} from '../executor/tar.ts';
import type { DurableRunRequest, Run, RunOutcome, RunsRepo } from '../repo/runs-repo.ts';
import { defaultInspectionLimits, inspectFiles, type InspectionLimits } from './file-inspection.ts';

type Status = RunBody['status'];

/** 放进 out/ 的占位文件：保证目录存在且属于沙箱用户，不算产出 */
const KEEP_FILE = '.oasis-keep';
const audioPath = /\.(wav|mp3|m4a|flac|ogg|webm|aac)$/i;
const videoPath = /\.(mp4|mov|mkv|avi|webm|mlt|srt)$/i;
/** 批次恢复状态随 tar 存档，但不是成果，也不传给下游节点。 */
const isPrivateOutput = (path: string) =>
  path === KEEP_FILE ||
  ['.oasis-batches', '.oasis-tools'].some((dir) => path === dir || path.startsWith(`${dir}/`));

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
  sessionId?: string;
  suspended?: boolean;
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
  outputs: saved.outputs?.files.filter((f) => !isPrivateOutput(f.path)) ?? [],
  outputKey: saved.outputs?.key ?? null,
  sessionKey: saved.session?.key ?? null,
});

function toRunBody(run: Run, resumable = Boolean(run.sessionKey)): RunBody {
  return {
    id: run.id,
    payerId: run.payerId,
    taskId: run.taskId,
    nodeId: run.nodeId,
    model: run.model,
    status: run.status,
    resumable,
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

type Material = Required<StartRunBody>['materials'][number];

export function createRunService(deps: {
  repo: RunsRepo;
  executor: Executor;
  store: ObjectStore;
  modelGateway: ServiceClient;
  /** 取用户上传的素材（ADR 0007 §4） */
  canvas: ServiceClient;
  /** 一次运行的素材加起来最多多大 */
  materialsMaxBytes?: number;
  transferTimeoutMs?: number;
  modelBaseUrl: string;
  packages: SandboxPackages;
  batchEnv?: Record<string, string>;
  inspectionLimits?: InspectionLimits;
  maxConcurrent: number;
  /** 显式验收超时；生产调用不设置。 */
  timeoutMs?: number;
  leaseMs?: number;
  goalRoundWindow?: number;
  keyTtlSeconds?: number;
  /** 沙箱的 CPU 核数（算力按 时长 × 核数 计费） */
  cores: number;
  outputMaxBytes?: number;
  serviceName: string;
  logger: Logger;
}) {
  const { repo, executor, store, logger } = deps;
  const live = new Map<string, LiveRun>();
  const sessions = new Set<string>();
  const controlRequests = new Map<string, 'stop' | 'cancel'>();
  const controlWrites = new Map<string, Promise<void>>();
  let closing = false;
  let recoveringRuns = false;
  let recoveryDone: Promise<void> = Promise.resolve();
  const gate = createGate(deps.maxConcurrent);

  async function admit(model: string, requires: string[] = []) {
    await executor.check();
    const environment = await executor.environment?.();
    const missing = requires.filter((name) => !environment?.capabilities.includes(name));
    if (missing.length)
      throw new HttpError(
        422,
        'execution_capability_unavailable',
        '运行环境不具备所需能力：' + missing.join('、'),
      );
    const { models } = await deps.modelGateway.json('GET', '/internal/v1/models/execution', {
      schema: ExecutionModels,
    });
    if (!models.length)
      throw new HttpError(503, 'model_catalog_unavailable', '模型能力目录尚未就绪，请稍后重交');
    if (!models.some((entry) => entry.id === model))
      throw new HttpError(422, 'model_unavailable', '模型执行能力缺失或当前不可用：' + model);
    return { models, environment };
  }

  function record(
    runId: string,
    run: LiveRun,
    kind: RunEventBody['kind'],
    data: Record<string, unknown>,
  ) {
    const seq = run.nextSeq++;
    if (kind === 'assistant_text' && !data.parentSessionId) run.lastText = String(data.text);
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
  async function archive(sandbox: Pick<Sandbox, 'readArchive'>, path: string, key: string) {
    const stream = await sandbox.readArchive(path);
    if (!stream) return undefined;
    const upload = new PassThrough();
    const index = new PassThrough();
    const fail = (error: Error) => {
      stream.destroy(error);
      upload.destroy(error);
      index.destroy(error);
    };
    stream.on('error', fail);
    const storing = store.putStream(key, upload, 'application/x-tar', {
      maxBytes: deps.outputMaxBytes,
    });
    const scanning = scanArchive(index, deps.outputMaxBytes);
    stream.pipe(upload);
    stream.pipe(index);
    try {
      const [, files] = await Promise.all([storing, scanning]);
      if (!files.length) {
        await store.delete(key);
        return undefined;
      }
      return { key, files };
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled([storing, scanning]);
      await store.delete(key);
      throw error;
    }
  }

  /** 取出产出和会话存档（会话存档失败不影响结果） */
  async function save(
    sandbox: Pick<Sandbox, 'readArchive' | 'inspectMedia'>,
    id: string,
  ): Promise<Saved> {
    const outputs = await archive(sandbox, SANDBOX_PATHS.outputs, `runs/${id}/outputs.tar`);
    if (
      outputs &&
      sandbox.inspectMedia &&
      !live.get(id)?.abort.signal.aborted &&
      outputs.files.some((file) => audioPath.test(file.path) || videoPath.test(file.path))
    ) {
      try {
        const report = VideoCheckResult.parse(
          await sandbox.inspectMedia(await store.read(outputs.key)),
        );
        for (const [kind, pattern] of [
          ['audio', audioPath],
          ['video', videoPath],
        ] as const) {
          await store.put(
            `runs/${id}/${kind}-check.json`,
            Buffer.from(
              JSON.stringify({
                files: report.files.filter((file) => pattern.test(file.path)),
                unchecked: report.unchecked.filter((file) => pattern.test(file)),
              }),
            ),
            'application/json',
          );
        }
      } catch (err) {
        logger.warn({ err, runId: id }, '媒体检查未完成，关卡将保留未检查提醒');
      }
    }
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
    const files: { dir: string; tar: Readable }[] = [];
    for (const ref of row.inputsFrom) {
      const upstream = await repo.get(ref.runId);
      if (!upstream?.outputKey) continue;
      files.push({
        dir: SANDBOX_PATHS.workdir,
        tar: rewriteArchive(
          await store.read(upstream.outputKey),
          `in/${ref.as}`,
          (path) => !isPrivateOutput(path),
          deps.outputMaxBytes,
        ),
      });
    }
    return files;
  }

  /**
   * 接着之前某次运行时要放回沙箱的东西：它的产出放回 out/，它的会话存档放回 dsh 的 sessions/
   * （去掉锁文件，否则恢复时会以为会话还被占着）。
   */
  async function continuation(row: Run) {
    const previous = row.continueFrom ? await repo.get(row.continueFrom) : undefined;
    if (!previous) return [];
    if (await executor.workspaceExists?.(row.sessionId ?? previous.id)) return [];
    const workspace = previous.outputKey
      ? [
          {
            dir: SANDBOX_PATHS.workdir,
            tar: rewriteArchive(
              await store.read(previous.outputKey),
              'out',
              (path) => path !== KEEP_FILE,
              deps.outputMaxBytes,
            ),
          },
        ]
      : [];
    const dshHome = previous.sessionKey
      ? [
          {
            dir: SANDBOX_PATHS.dshHome,
            tar: rewriteArchive(
              await store.read(previous.sessionKey),
              'sessions',
              (path) => !isSessionLock(path),
              deps.outputMaxBytes,
            ),
          },
        ]
      : [];
    return [...workspace, ...dshHome];
  }

  /** 用户给的素材：向 canvas 取出来，放到 materials/ 下（路径已由 task 定好、契约校验过） */
  async function materialFiles(materials: Material[], runId: string, ownerId: string) {
    if (!materials.length) return [];
    const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
      body: { ownerId, ids: materials.map((file) => file.uploadId) },
      schema: UploadLookupResult,
      requestId: runId,
    });
    const metadata = new Map(uploads.map((file) => [file.id, file]));
    let total = 0;
    return materials.map((m) => {
      const info = metadata.get(m.uploadId);
      if (!info) throw new Error('素材元数据缺失');
      total += info.size;
      if (deps.materialsMaxBytes !== undefined && total > deps.materialsMaxBytes)
        throw new StopRun('failed', '素材加起来超过运行上限');
      return {
        path: m.path,
        size: info.size,
        sha256: info.sha256,
        open: async () => {
          const response = await deps.canvas.stream(
            'GET',
            `/internal/uploads/${encodeURIComponent(m.uploadId)}/content`,
            { requestId: runId, signal: AbortSignal.timeout(deps.transferTimeoutMs ?? 600_000) },
          );
          if (!response.body) throw new Error('素材没有内容流');
          return Readable.fromWeb(response.body);
        },
      };
    });
  }

  async function execute(
    row: Run,
    inputs: { path: string; content: Buffer }[],
    materials: Material[],
    run: LiveRun,
    mode: { goal: boolean; reasoningEffort?: 'max' },
    catalog: { models: ModelCapabilities[]; environment?: ExecutionEnvironment },
    persistent = false,
    recovering = false,
  ) {
    const { id } = row;
    const { goal, reasoningEffort } = mode;
    const { models, environment } = catalog;
    const release = await gate.acquire();
    let sandbox: Sandbox | undefined;
    let keyId: string | undefined;
    let keyRevoked = false;
    let checkpointFailed = false;
    let sandboxEndedAt: number | undefined;
    // 算力计费：开沙箱前冻结，销毁后按沙箱实际存在的时长结算（单价为 0 时没有 callId）
    let lease: Awaited<ReturnType<typeof startRunLease>> | undefined;
    const timer = deps.timeoutMs
      ? setTimeout(
          () =>
            run.abort.abort(
              new StopRun(
                'failed',
                `运行超时（${Math.round((deps.timeoutMs ?? 0) / 60_000)} 分钟）`,
              ),
            ),
          deps.timeoutMs,
        )
      : undefined;
    const outcome: Omit<RunOutcome, 'finishedAt'> = {
      status: 'failed',
      error: null,
      outputs: [],
      outputKey: null,
      sessionKey: null,
      summary: null,
    };
    const unavailable = (error: unknown) => error instanceof HttpError && error.statusCode >= 500;
    const suspend = (error: unknown) => {
      if (run.abort.signal.aborted) return;
      run.suspended = true;
      record(id, run, 'status', { status: 'recovery_wait', reason: '执行依赖暂不可用，等待接管' });
      logger.warn({ err: error, runId: id }, '依赖中断，保存原会话等待接管');
      run.abort.abort(new StopRun('stopped', '执行依赖暂不可用，进度保留待接管'));
    };
    try {
      const stopped = () => {
        const reason: unknown = run.abort.signal.reason;
        if (run.abort.signal.aborted)
          throw reason instanceof StopRun ? reason : new StopRun('cancelled', '已取消');
      };
      stopped();
      await repo.update(id, { status: 'starting', error: null });

      const key = await deps.modelGateway.json('POST', '/internal/run-keys', {
        body: {
          runId: id,
          payerId: row.payerId,
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.nodeId ? { nodeId: row.nodeId } : {}),
          ttlSeconds: deps.keyTtlSeconds ?? 6 * 3600,
        },
        requestId: id,
        schema: RunKeyCreated,
      });
      keyId = key.keyId;
      await repo.update(id, { runKeyId: keyId });
      lease = await startRunLease({
        client: deps.modelGateway,
        runId: id,
        payerId: row.payerId,
        taskId: row.taskId,
        nodeId: row.nodeId,
        keyId,
        keyTtlSeconds: deps.keyTtlSeconds ?? 6 * 3600,
        cores: deps.cores,
        windowMs: deps.leaseMs ?? 5 * 60_000,
        onFailure: (error) => {
          if (unavailable(error)) suspend(error);
          else
            run.abort.abort(new StopRun('stopped', '运行租约续期失败，已停止：' + String(error)));
        },
      });
      stopped();

      const restored = await continuation(row);
      const files = [
        ...runtimeFiles({
          models,
          sessionId: row.sessionId ?? id,
          objective: row.prompt,
          goal,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          goalRoundWindow: deps.goalRoundWindow ?? 256,
          recovering,
          environment,
        }),
        ...(recovering && persistent
          ? []
          : inputs.map((f) => ({ path: `in/${f.path}`, content: f.content }))),
        // 保证 out/ 目录存在且属于沙箱用户
        { path: `out/${KEEP_FILE}`, content: Buffer.alloc(0) },
      ];
      sandbox = await executor.start({
        runId: id,
        ...(persistent
          ? {
              workspaceId: row.sessionId ?? id,
              restore: recovering || Boolean(row.continueFrom && restored.length === 0),
            }
          : {}),
        env: {
          ...deps.batchEnv,
          OASIS_TOOL_SCOPE: row.nodeId ?? row.sessionId ?? id,
          ...sandboxEnv({
            modelBaseUrl: deps.modelBaseUrl,
            runKey: key.key,
            model: row.model,
            packages: deps.packages,
          }),
        },
        files: [
          { dir: SANDBOX_PATHS.workdir, tar: await packFiles(files) },
          ...(recovering && persistent
            ? []
            : [
                {
                  dir: SANDBOX_PATHS.workdir,
                  tar: packStreams(await materialFiles(materials, id, row.payerId)),
                },
                ...(await upstreamFiles(row)),
              ]),
          ...restored,
        ],
      });
      const box = sandbox;
      run.abort.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = run.abort.signal.reason;
          if (reason instanceof StopRun && reason.status !== 'cancelled') {
            // 停止：先把已经做出来的东西存下来，再销毁沙箱
            run.saved = box
              .pause()
              .then(() => save(box, id))
              .finally(async () => {
                await box.destroy();
                sandboxEndedAt ??= Date.now();
              });
          } else {
            void box.destroy();
          }
        },
        { once: true },
      );
      // 沙箱启动期间就被取消或停止了：上面的监听来不及收到，这里补上（finally 会销毁沙箱）
      stopped();
      await repo.update(id, {
        containerId: sandbox.id,
        status: 'running',
        startedAt: row.startedAt ?? new Date(),
      });

      let stderrTail = '';
      sandbox.stderr.setEncoding('utf8');
      sandbox.stderr.on('data', (text: string) => {
        stderrTail = (stderrTail + text).slice(-2000);
      });

      const agent = connectAgent({
        stdin: sandbox.stdin,
        stdout: sandbox.stdout,
        sessionId: row.sessionId ?? id,
        goal,
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
      let fresh = false;
      if (recovering && executor.workspaceExists) {
        const source = await sandbox.readArchive(SANDBOX_PATHS.sessions);
        const paths = source
          ? (await scanArchive(source, deps.outputMaxBytes)).map((f) => f.path)
          : [];
        if (!paths.some((p) => isSessionArchive(p, row.sessionId ?? id))) {
          if (paths.some((p) => isSessionArchive(p)) || (await repo.hasRootPrompt(id)))
            throw new Error('原生根会话缺失，不能丢弃已有历史');
          fresh = true; // 原进程尚未创建原生会话，原子保存的请求仍可首次派发。
        }
      }
      const restoredSession =
        row.continueFrom || (recovering && !fresh) ? await agent.resume() : undefined;
      if (!recovering || !goal || fresh || restoredSession?.needsPrompt) {
        run.prompts += 1;
        await agent.prompt(
          recovering && !fresh
            ? '服务连接中断后已恢复原工作目录和原会话。请从未完成处继续，不重做已有工作。'
            : row.prompt,
        );
      }
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
      if (unavailable(err)) suspend(err);
      const stop = err instanceof StopRun ? err : run.abort.signal.reason;
      if (stop instanceof StopRun) {
        Object.assign(outcome, { status: stop.status, error: stop.message });
        if (run.saved) {
          const saved = await run.saved.catch((saveErr: unknown) => {
            checkpointFailed = true;
            logger.warn({ err: saveErr, runId: id }, '停止时保存产出失败');
            outcome.error = '已停止，但进度保存失败，不能保证恢复';
            return {};
          });
          Object.assign(outcome, savedOutcome(saved));
        }
      } else {
        logger.error({ err, runId: id }, '运行失败');
        outcome.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (sandbox && outcome.status === 'failed' && !run.abort.signal.aborted) {
        await sandbox
          .pause()
          .then(() => save(sandbox!, id))
          .then((saved) => Object.assign(outcome, savedOutcome(saved)))
          .catch((err: unknown) => logger.warn({ err, runId: id }, '失败时保存进度失败'));
      }
      clearTimeout(timer);
      run.closing = true;
      outcome.summary = run.lastText ?? null;
      await sandbox
        ?.destroy()
        .then(() => {
          sandboxEndedAt ??= Date.now();
        })
        .catch((err: unknown) => logger.warn({ err, runId: id }, '销毁沙箱失败'));
      const endedAt = sandboxEndedAt ?? Date.now();
      if (run.suspended && sandboxEndedAt !== undefined)
        record(id, run, 'status', {
          status: 'suspended',
          endedAt: new Date(endedAt).toISOString(),
          cores: deps.cores,
          keyId: keyId ?? null,
        });
      const settlement = lease
        ?.close(endedAt, !sandbox || sandboxEndedAt !== undefined)
        .catch((err: unknown) => logger.warn({ err, runId: id }, '算力租约结算失败'));
      if (outcome.status !== 'succeeded' && !run.suspended) {
        await deps.modelGateway
          .json('POST', `/internal/v1/tools/runs/${id}/cancel`, {
            body: {},
            requestId: id,
            headers: {
              'x-oasis-payer-id': row.payerId,
              ...(row.taskId ? { 'x-oasis-task-id': row.taskId } : {}),
            },
          })
          .catch((err: unknown) =>
            logger.warn({ err, runId: id }, '长任务取消意图写入失败，费用仍需核对'),
          );
      }
      if (keyId) {
        await deps.modelGateway
          .json('POST', `/internal/run-keys/${keyId}/revoke`, { body: {}, requestId: id })
          .then(() => {
            keyRevoked = true;
          })
          .catch((err: unknown) => logger.warn({ err, runId: id }, '作废临时 Key 失败，等它过期'));
      }
      await settlement;
      release();
    }
    await run.writes;
    const control = controlRequests.get(id);
    if (control) {
      run.suspended = false;
      outcome.status = control === 'cancel' ? 'cancelled' : 'stopped';
      if (!checkpointFailed) outcome.error = control === 'cancel' ? '已取消' : '已停止';
    }
    if (run.suspended) {
      await repo.update(id, {
        status: 'queued',
        containerId: null,
        // 撤销失败时保留旧 Key 标识，接管须先真正作废它再发新凭证。
        runKeyId: keyRevoked ? null : (keyId ?? row.runKeyId),
        outputs: outcome.outputs,
        outputKey: outcome.outputKey,
        sessionKey: outcome.sessionKey,
        summary: outcome.summary,
      });
    } else await finish(row, outcome);
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
      resumable:
        Boolean(outcome.sessionKey) ||
        Boolean(await executor.workspaceExists?.(row.sessionId ?? row.id)),
      error: outcome.error,
      outputs: outcome.outputs,
      summary: outcome.summary,
      finishedAt: finishedAt.toISOString(),
    });
    await repo.finish(row.id, { ...outcome, finishedAt }, event);
    controlRequests.delete(row.id);
    logger.info({ runId: row.id, status, outputs: outcome.outputs.length }, '运行结束');
  }

  async function owned(id: string): Promise<Run> {
    const row = await repo.get(id);
    if (!row) throw new HttpError(404, 'run_not_found', '没有这次运行');
    return row;
  }

  async function requestControl(id: string, how: 'stop' | 'cancel') {
    controlRequests.set(id, how);
    const run = live.get(id);
    const seq = run ? run.nextSeq++ : undefined;
    const writing = (run?.writes ?? controlWrites.get(id) ?? Promise.resolve()).then(async () =>
      repo.appendEvents(id, [
        {
          seq: seq ?? (await repo.nextSequence(id)),
          kind: 'status',
          data: { status: 'control_requested', how },
        },
      ]),
    );
    if (run) run.writes = writing;
    controlWrites.set(id, writing);
    try {
      await writing;
    } catch (err) {
      controlRequests.delete(id);
      throw err;
    } finally {
      if (controlWrites.get(id) === writing) controlWrites.delete(id);
    }
  }

  /** 接管等待期间的用户控制意图也必须生效，不能因当前没有 LiveRun 而丢掉。 */
  async function restoreControl(row: Run): Promise<boolean> {
    await controlWrites.get(row.id);
    const stored = await repo.control(row.id);
    const how = controlRequests.get(row.id) ?? stored;
    if (!how) return false;
    const saved =
      how === 'stop' && executor.readStoredArchive
        ? await save({ readArchive: (path) => executor.readStoredArchive!(row.id, path) }, row.id)
        : {};
    await deps.modelGateway.json('POST', `/internal/v1/tools/runs/${row.id}/cancel`, {
      body: {},
      requestId: row.id,
      headers: {
        'x-oasis-payer-id': row.payerId,
        ...(row.taskId ? { 'x-oasis-task-id': row.taskId } : {}),
      },
    });
    await controlWrites.get(row.id);
    const latest = controlRequests.get(row.id) ?? (await repo.control(row.id)) ?? how;
    await finish(row, {
      status: latest === 'cancel' ? 'cancelled' : 'stopped',
      error: latest === 'cancel' ? '已取消' : '已停止',
      outputs: saved.outputs?.files.filter((f) => !isPrivateOutput(f.path)) ?? row.outputs,
      outputKey: saved.outputs?.key ?? row.outputKey,
      sessionKey: saved.session?.key ?? row.sessionKey,
      summary: row.summary,
    });
    controlRequests.delete(row.id);
    return true;
  }

  async function checkedMedia(
    id: string,
    payerId: string,
    taskId: string,
    kind: 'audio' | 'video',
  ) {
    const row = await owned(id);
    if (row.payerId !== payerId || row.taskId !== taskId)
      throw new HttpError(404, 'run_not_found', '没有这次运行');
    const expected = row.outputs.filter((file) =>
      (kind === 'audio' ? audioPath : videoPath).test(file.path),
    );
    let report: ReturnType<typeof VideoCheckResult.parse>;
    try {
      report = VideoCheckResult.parse(
        JSON.parse((await store.get(`runs/${id}/${kind}-check.json`)).toString('utf8')),
      );
    } catch {
      return { files: [], unchecked: expected.map((file) => file.path) };
    }
    const files = report.files.filter((file) =>
      expected.some(
        (output) =>
          output.path === file.path &&
          output.size === file.size &&
          output.sha256 === file.sha256 &&
          Boolean(file.sha256),
      ),
    );
    return {
      files,
      unchecked: expected
        .filter((output) => !files.some((file) => file.path === output.path))
        .map((file) => file.path),
    };
  }

  return {
    async start(
      body: StartRunBody & Required<Pick<StartRunBody, 'inputs' | 'inputsFrom'>>,
    ): Promise<RunBody> {
      if (closing) throw new HttpError(503, 'harness_closing', '执行服务正在重启，请稍后重交');
      if (body.runId) {
        const existing = await repo.get(body.runId);
        if (existing) {
          if (existing.payerId !== body.payerId || existing.model !== body.model)
            throw new HttpError(409, 'run_id_conflict', '这个运行 ID 已经被别的运行用了');
          return toRunBody(existing);
        }
      }
      // 目录未就绪属于准入等待，不登记失败运行，也不消耗节点重试次数。
      const catalog = await admit(body.model, body.requires);
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
        const hasWorkspace =
          previous && Boolean(await executor.workspaceExists?.(previous.sessionId ?? previous.id));
        if (
          previous?.payerId !== body.payerId ||
          !ended ||
          (!previous.sessionKey && !hasWorkspace)
        ) {
          throw new HttpError(
            409,
            'continue_unavailable',
            '要接着的那次运行不存在、还没结束或没有会话存档',
          );
        }
        const oldRequest = (await repo.request(previous.id)) as DurableRunRequest | undefined;
        if (oldRequest?.persistent) {
          if (!(await executor.workspaceExists?.(previous.sessionId ?? previous.id)))
            throw new HttpError(
              409,
              'workspace_unavailable',
              '原会话持久工作目录缺失，不能仅凭旧产出冒充完整恢复',
            );
          const history = await repo.listBySession(previous.sessionId ?? previous.id);
          if (history.some((r) => r.id !== previous!.id && r.createdAt > previous!.createdAt))
            throw new HttpError(409, 'session_advanced', '该会话已有后续运行，请从最新进度继续');
        }
      }
      const id = body.runId ?? randomUUID();
      const sessionId = previous ? (previous.sessionId ?? previous.id) : id;
      const finishing = [...live.values()].find((r) => r.sessionId === sessionId && r.closing);
      if (finishing) await finishing.done;
      if (sessions.has(sessionId) || [...live.values()].some((r) => r.sessionId === sessionId))
        throw new HttpError(409, 'session_busy', '原会话仍有运行，不能同时修改同一工作目录');
      sessions.add(sessionId);
      const persistent = Boolean(executor.workspaceExists);
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
          { body, persistent },
        );
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
          nextSeq: await repo.nextSequence(id),
          writes: Promise.resolve(),
          done: Promise.resolve(),
          sessionId,
        };
        live.set(id, run);
        const inputs = body.inputs.map((f) => ({
          path: f.path,
          content: Buffer.from(f.contentBase64, 'base64'),
        }));
        run.done = execute(
          row,
          inputs,
          body.materials ?? [],
          run,
          {
            goal: body.goal ?? false,
            ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          },
          catalog,
          persistent,
        ).catch((err: unknown) => logger.error({ err, runId: id }, '运行收尾失败'));
        return toRunBody(row);
      } finally {
        sessions.delete(sessionId);
      }
    },

    get: async (id: string) => {
      const row = await owned(id);
      return toRunBody(
        row,
        Boolean(row.sessionKey) ||
          Boolean(await executor.workspaceExists?.(row.sessionId ?? row.id)),
      );
    },
    /**
     * 运行中沙箱里 out/<dir> 的当前文件（节点自查 app.check 用，ADR 0017）：只给这次运行的付款人和任务，
     * 运行结束后读不到（成果以归档为准）。
     */
    liveFiles: async (input: { runId: string; payerId: string; taskId: string; dir: string }) => {
      const row = await owned(input.runId);
      if (row.payerId !== input.payerId || row.taskId !== input.taskId)
        throw new HttpError(404, 'run_not_found', '没有这次运行');
      if (row.status !== 'running' || !executor.readStoredArchive)
        throw new HttpError(409, 'run_not_running', '只能检查正在运行的节点的成果');
      const stream = await executor.readStoredArchive(
        input.runId,
        `${SANDBOX_PATHS.outputs}/${input.dir}`,
      );
      if (!stream) throw new HttpError(404, 'dir_not_found', `out/${input.dir} 不存在`);
      return extractFiles(await readLimited(stream, 100 * 1024 * 1024 + 1024 * 1024));
    },
    environment: async () => {
      if (!executor.environment)
        throw new HttpError(503, 'environment_unavailable', '执行环境尚未提供探测结果');
      return executor.environment();
    },

    /**
     * 任务被删除（ADR 0012）：删掉它已结束的运行的产出包、会话存档和运行记录。
     * 还没结束的运行（正常不会有）先留着，返回 false，事件重投时再删。
     */
    async purgeTask(taskId: string): Promise<boolean> {
      const rows = await repo.listByTask(taskId);
      const ended = rows.filter((row) => !['queued', 'starting', 'running'].includes(row.status));
      for (const row of ended) {
        if (row.outputKey) await store.delete(row.outputKey);
        if (row.sessionKey) await store.delete(row.sessionKey);
        for (const kind of ['audio', 'video', 'application'])
          await store.delete(`runs/${row.id}/${kind}-check.json`);
      }
      if (ended.length === rows.length)
        for (const sessionId of new Set(ended.map((r) => r.sessionId ?? r.id)))
          if (!(await repo.listBySession(sessionId)).some((r) => r.taskId !== taskId))
            await executor.purgeWorkspace?.(sessionId);
      await repo.removeMany(ended.map((row) => row.id));
      if (ended.length) logger.info({ taskId, runs: ended.length }, '任务已删除，运行存档一并清理');
      return ended.length === rows.length;
    },

    async events(id: string, afterSeq: number, limit: number): Promise<RunEventBody[]> {
      await owned(id);
      const rows = await repo.listEvents(id, afterSeq, limit);
      return rows.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        data: e.data.status === 'admitted' && e.seq === 0 ? { status: 'admitted' } : e.data,
        createdAt: e.createdAt.toISOString(),
      }));
    },

    /** 文字类产出（给关卡检查用）：按路径顺序读，总长超过 maxChars 就截断 */
    async texts(id: string, maxChars: number, paths?: string[]): Promise<RunTextsBody> {
      const row = await owned(id);
      if (!row.outputKey) return { files: [], truncated: false };
      const result: RunTextsBody = { files: [], truncated: false };
      const limits = deps.inspectionLimits ?? defaultInspectionLimits;
      const started = Date.now();
      let left = maxChars;
      let audio: ReturnType<typeof AudioCheckResult.parse> | undefined;
      try {
        audio = AudioCheckResult.parse(
          JSON.parse((await store.get(`runs/${id}/audio-check.json`)).toString('utf8')),
        );
      } catch {
        /* 没有受信音频报告时保留未检查 */
      }
      let video: ReturnType<typeof VideoCheckResult.parse> | undefined;
      try {
        video = VideoCheckResult.parse(
          JSON.parse((await store.get(`runs/${id}/video-check.json`)).toString('utf8')),
        );
      } catch {
        /* 历史运行没有视频报告时，保留未检查。 */
      }
      await scanArchive(
        await store.read(row.outputKey),
        deps.outputMaxBytes,
        async (path, size, stream) => {
          if (isPrivateOutput(path) || (paths !== undefined && !paths.includes(path))) return;
          if (result.files.length >= limits.files || Date.now() - started > limits.totalMs) {
            result.truncated = true;
            return;
          }
          if (audioPath.test(path) || videoPath.test(path)) {
            const reports = videoPath.test(path) ? video : audio;
            const checked = reports?.files.find(
              (file) =>
                file.path === path &&
                file.size === size &&
                file.sha256 === row.outputs.find((output) => output.path === path)?.sha256 &&
                Boolean(file.sha256),
            );
            result.files.push({
              path,
              valid: checked?.valid ?? false,
              ...(checked?.valid
                ? {
                    evidenceScope: videoPath.test(path)
                      ? ('decoded-video' as const)
                      : ('decoded-audio' as const),
                  }
                : {}),
              text: checked ? JSON.stringify(checked) : '',
              ...(checked?.error
                ? { error: checked.error }
                : {
                    warning: checked
                      ? videoPath.test(path)
                        ? '视频/工程/字幕已完成受信结构检查；画面、音画语义及 Shotcut 重导出仍需核对'
                        : '音频已探测并解码；发音、歌词和音乐内容仍需试听核对'
                      : '媒体检查未完成',
                  }),
            });
            return;
          }
          if (size > limits.inputBytes) {
            result.files.push({
              path,
              text: '',
              valid: false,
              error: '文件超过解析大小上限',
              errorKind: 'incomplete',
            });
            return;
          }
          const checked = await inspectFiles(
            [{ path, content: await readLimited(stream, limits.inputBytes) }],
            left,
            limits,
          );
          result.files.push(...checked.files);
          result.truncated ||= checked.truncated;
          left -= checked.files.reduce((sum, file) => sum + file.text.length, 0);
        },
      );
      return result;
    },

    /** 读一个产出文件（下载成果、读规划员写的方案用）；没有这个文件时 404 */
    async file(id: string, path: string): Promise<{ content: Buffer; contentType: string }> {
      const row = await owned(id);
      const found = row.outputs.find((f) => f.path === path && !isPrivateOutput(f.path));
      if (!found) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: await readLimited(
          archiveFile(await store.read(row.outputKey!), path),
          deps.inspectionLimits?.inputBytes ?? 100 * 1024 * 1024,
        ),
        contentType: contentTypeOf(path),
      };
    },

    async fileStream(id: string, path: string) {
      const row = await owned(id);
      const found = row.outputs.find((file) => file.path === path && !isPrivateOutput(path));
      if (!found || !row.outputKey) throw new HttpError(404, 'file_not_found', '没有这个文件');
      return {
        content: archiveFile(await store.read(row.outputKey), path),
        contentType: contentTypeOf(path),
        size: found.size,
        sha256: found.sha256,
      };
    },

    async audioCheck(id: string, payerId: string, taskId: string) {
      return checkedMedia(id, payerId, taskId, 'audio');
    },
    async videoCheck(id: string, payerId: string, taskId: string) {
      return checkedMedia(id, payerId, taskId, 'video');
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
      const row = await owned(id);
      const run = live.get(id);
      if (
        !['queued', 'starting', 'running'].includes(row.status) ||
        (run?.closing && !run.suspended)
      )
        return;
      await requestControl(id, 'stop');
      if (run) {
        run.suspended = false;
        run.abort.abort(new StopRun('stopped', '已停止'));
      } else {
        void this.recover().catch((err: unknown) =>
          logger.warn({ err, runId: id }, '停止意图已保存，等待接管执行'),
        );
      }
    },

    /** 取消：排队中的不再开始，运行中的立即销毁沙箱。已结束的取消不报错。 */
    async cancel(id: string): Promise<void> {
      const row = await owned(id);
      const run = live.get(id);
      if (!['queued', 'starting', 'running'].includes(row.status)) return;
      await requestControl(id, 'cancel');
      if (run) {
        run.suspended = false;
        run.abort.abort(new StopRun('cancelled', '已取消'));
      } else {
        void this.recover().catch((err: unknown) =>
          logger.warn({ err, runId: id }, '取消意图已保存，等待接管执行'),
        );
      }
    },

    /** 单实例启动接管：先停旧进程，再恢复原身份和原工作目录；不发布中间失败。 */
    async recover(): Promise<void> {
      if (closing) return;
      if (recoveringRuns) return recoveryDone;
      recoveringRuns = true;
      let complete!: () => void;
      recoveryDone = new Promise<void>((resolve) => {
        complete = resolve;
      });
      try {
        for (const row of await repo.listUnfinished()) {
          if (live.has(row.id) || sessions.has(row.sessionId ?? row.id)) continue;
          try {
            const suspended = await executor.suspend?.(row.id);
            const savedStop = !suspended ? await repo.suspension?.(row.id) : undefined;
            const checkpoint =
              savedStop && (row.status === 'queued' || savedStop.keyId === row.runKeyId)
                ? savedStop
                : undefined;
            const endedAt =
              suspended?.endedAt ?? (checkpoint ? new Date(checkpoint.endedAt) : new Date());
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
            if (await restoreControl(row)) continue;
            let request: DurableRunRequest;
            try {
              const saved = (await repo.request(row.id)) as DurableRunRequest | undefined;
              if (!saved) throw new Error('没有与运行原子保存的启动请求');
              request = {
                body: StartRunSchema.parse(saved.body),
                persistent: saved.persistent === true,
              };
              if (
                request.persistent &&
                row.startedAt &&
                !(await executor.workspaceExists?.(row.sessionId ?? row.id))
              )
                throw new Error('原运行持久工作目录缺失，不能从空目录恢复');
            } catch (err) {
              await finish(row, {
                status: 'failed',
                error: '恢复状态不可用：' + (err instanceof Error ? err.message : String(err)),
                outputs: row.outputs,
                outputKey: row.outputKey,
                sessionKey: row.sessionKey,
                summary: row.summary,
              });
              continue;
            }
            const catalog = await admit(row.model, request.body.requires);
            const run: LiveRun = {
              abort: new AbortController(),
              prompts: 0,
              closing: false,
              nextSeq: await repo.nextSequence(row.id),
              writes: Promise.resolve(),
              done: Promise.resolve(),
              sessionId: row.sessionId ?? row.id,
            };
            if (await restoreControl(row)) continue;
            live.set(row.id, run);
            record(row.id, run, 'status', { status: 'recovering', sessionId: run.sessionId });
            run.done = execute(
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
              },
              catalog,
              request.persistent,
              Boolean(row.startedAt),
            ).catch((err: unknown) => logger.error({ err, runId: row.id }, '恢复运行收尾失败'));
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
        const keep = new Set([...live.keys(), ...(await repo.listUnfinished()).map((r) => r.id)]);
        const removed = await executor.removeOrphans(keep);
        if (removed > 0) logger.info({ removed }, '清理了遗留的沙箱容器');
      } finally {
        recoveringRuns = false;
        complete();
      }
    },

    /** 服务关闭：中止所有进行中的运行并等它们收尾。 */
    async stopAll(): Promise<void> {
      closing = true;
      await recoveryDone;
      const runs = [...live.values()];
      for (const [id, run] of live) {
        if (run.closing) continue;
        if (controlRequests.has(id) || (run.abort.signal.aborted && !run.suspended)) continue;
        run.suspended = true;
        run.abort.abort(new StopRun('stopped', '执行服务关闭，进度保留待接管'));
      }
      await Promise.all(runs.map((run) => run.done));
    },
  };
}

export type RunService = ReturnType<typeof createRunService>;
