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
} from '@oasis/contracts/harness';
import { ComputeHold, RunKeyCreated } from '@oasis/contracts/model-gateway';
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
  SANDBOX_PATHS,
  sandboxEnv,
  type SandboxPackages,
  type AgentConnection,
} from '../adapter/dsh.ts';
import type { Executor, Sandbox } from '../executor/executor.ts';
import {
  archiveFile,
  packFiles,
  packStreams,
  readLimited,
  rewriteArchive,
  scanArchive,
} from '../executor/tar.ts';
import type { Run, RunOutcome, RunsRepo } from '../repo/runs-repo.ts';
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

type Material = Required<StartRunBody>['materials'][number];

export function createRunService(deps: {
  repo: RunsRepo;
  executor: Executor;
  store: ObjectStore;
  modelGateway: ServiceClient;
  /** 取用户上传的素材（ADR 0007 §4） */
  canvas: ServiceClient;
  /** 一次运行的素材加起来最多多大 */
  materialsMaxBytes: number;
  transferTimeoutMs?: number;
  modelBaseUrl: string;
  packages: SandboxPackages;
  batchEnv?: Record<string, string>;
  inspectionLimits?: InspectionLimits;
  maxConcurrent: number;
  timeoutMs: number;
  /** 沙箱的 CPU 核数（算力按 时长 × 核数 计费） */
  cores: number;
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
  async function save(sandbox: Sandbox, id: string): Promise<Saved> {
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
      if (total > deps.materialsMaxBytes) throw new StopRun('failed', '素材加起来超过运行上限');
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
  ) {
    const { id } = row;
    const release = await gate.acquire();
    let sandbox: Sandbox | undefined;
    let keyId: string | undefined;
    // 算力计费：开沙箱前冻结，销毁后按沙箱实际存在的时长结算（单价为 0 时没有 callId）
    let computeCallId: string | null = null;
    let sandboxSince: number | undefined;
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
      ({ callId: computeCallId } = await deps.modelGateway.json('POST', '/internal/v1/compute', {
        body: {
          runId: id,
          payerId: row.payerId,
          taskId: row.taskId,
          nodeId: row.nodeId,
          cores: deps.cores,
          maxMs: deps.timeoutMs,
        },
        requestId: id,
        schema: ComputeHold,
      }));
      stopped();

      const restored = await continuation(row);
      const files = [
        ...inputs.map((f) => ({ path: `in/${f.path}`, content: f.content })),
        // 保证 out/ 目录存在且属于沙箱用户
        { path: `out/${KEEP_FILE}`, content: Buffer.alloc(0) },
      ];
      sandboxSince = Date.now();
      sandbox = await executor.start({
        runId: id,
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
          {
            dir: SANDBOX_PATHS.workdir,
            tar: packStreams(await materialFiles(materials, id, row.payerId)),
          },
          ...(await upstreamFiles(row)),
          ...restored,
        ],
      });
      const box = sandbox;
      run.abort.signal.addEventListener(
        'abort',
        () => {
          const reason: unknown = run.abort.signal.reason;
          if (reason instanceof StopRun && reason.status === 'stopped') {
            // 停止：先把已经做出来的东西存下来，再销毁沙箱
            run.saved = box
              .pause()
              .then(() => save(box, id))
              .finally(() => box.destroy());
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
      if (computeCallId) {
        const elapsedMs = sandboxSince === undefined ? 0 : Date.now() - sandboxSince;
        await deps.modelGateway
          .json('POST', `/internal/v1/compute/${computeCallId}/settle`, {
            body: { cores: deps.cores, elapsedMs },
            requestId: id,
          })
          .catch((err: unknown) => logger.warn({ err, runId: id }, '算力结算失败，冻结将过期退回'));
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
      run.done = execute(row, inputs, body.materials ?? [], run).catch((err: unknown) =>
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
