// 执行一轮：排队 → 签发临时 Key、冻结算力 → 起沙箱（挂上这个会话的持久工作目录）、放入平台说明、
// 技能和用户发的文件 → dsh 握手、接着原会话、交用户的话 → 记录事件 → 等这一轮做完（期间可插话）
// → 给 Word/PPT 配 PDF、取出产出存进对象存储 → 销毁沙箱、作废 Key、结算算力 → 写结局。
// 依赖暂时不可用时保存原会话，等接管（control.ts）。
import { ExecutionModels, RunKeyCreated } from '@oasis/contracts/model-gateway';
import { HttpError, packFiles, packStreams, scanArchive } from '@oasis/service-kit';
import {
  connectAgent,
  guideFiles,
  isSessionArchive,
  runtimeFiles,
  SANDBOX_PATHS,
  sandboxEnv,
  type AgentConnection,
} from '../../adapter/dsh.ts';
import type { Sandbox } from '../../executor/executor.ts';
import type { Run, RunOutcome } from '../../repo/runs-repo.ts';
import { startRunLease } from '../run-lease.ts';
import { setupNote } from './setup.ts';
import { KEEP_FILE, savedOutcome, StopRun, type LiveRun, type RunContext } from './shared.ts';

/** 服务重启接管时交给 AI 的话：原会话和工作目录已恢复，接着做 */
const RECOVERED = '服务连接中断后已恢复原工作目录和原会话。请从未完成处继续，不重做已有工作。';

export function createExecution(
  ctx: RunContext,
): Pick<RunContext, 'admit' | 'record' | 'execute' | 'finish'> {
  const { deps, state } = ctx;
  const { repo, logger } = deps;

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

  /** 起 dsh、交用户的话（接着上一轮或接管时先恢复原会话），等这一轮做完；返回连接（收尾时关）和失败原因 */
  async function driveAgent(input: {
    row: Run;
    run: LiveRun;
    sandbox: Sandbox;
    recovering: boolean;
    stopped: () => void;
    stderr: () => string;
  }): Promise<{ agent: AgentConnection; failure: string | undefined }> {
    // 这一轮是新起的沙箱：项目里有 oasis-setup.sh 就先执行，结果接在交给 AI 的话后面
    const setup = await setupNote(input.sandbox, SANDBOX_PATHS.workdir, deps.setupSeconds ?? 300);
    const { row, run, sandbox, recovering, stopped } = input;
    const id = row.id;
    const agent = connectAgent({
      stdin: sandbox.stdin,
      stdout: sandbox.stdout,
      sessionId: row.sessionId ?? id,
      onEvent: (event) => ctx.record(id, run, event.kind, event.data),
    });
    run.abort.signal.addEventListener('abort', () => agent.abort(new Error('运行已中止')), {
      once: true,
    });
    try {
      // 用户电脑上工作目录是用户选的项目文件夹
      await agent.initialize(row.model, row.workplace?.folder ?? SANDBOX_PATHS.workdir);
    } catch (err) {
      stopped();
      throw new Error(`dsh 启动失败：${String(err)}；stderr：${input.stderr()}`, { cause: err });
    }
    let fresh = false;
    if (recovering) {
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
    if (row.continueFrom || (recovering && !fresh)) await agent.resume();
    run.prompts += 1;
    run.opening = 'sent';
    await agent.prompt((recovering && !fresh ? RECOVERED : row.prompt) + setup);
    // 插话排在开头那句后面：AI 还没开始时先到的按顺序送完，之后来的直接送
    while (run.queued.length) {
      run.prompts += 1;
      await agent.prompt(run.queued.shift()!);
    }
    run.agent = agent;
    return { agent, failure: await settle(run, agent) };
  }

  return {
    async admit(executor, model, domesticOnly) {
      await executor.check();
      const environment = await executor.environment?.();
      const listed = async (domestic: boolean) =>
        (
          await deps.modelGateway.json(
            'GET',
            `/internal/v1/models/execution${domestic ? '?domesticOnly=true' : ''}`,
            { schema: ExecutionModels },
          )
        ).models;
      const models = await listed(domesticOnly);
      const executable = (list: typeof models) => list.some((entry) => entry.id === model);
      if (!executable(models)) {
        // 打开了「只用国内模型」：国外厂商的 AI 暂停，聊天记录都在
        if (domesticOnly && executable(await listed(false)))
          throw new HttpError(
            409,
            'model_out_of_scope',
            '已打开「只用国内模型」，这个 AI 是国外厂商的，先暂停（聊天记录都在，在「AI 们」里关掉就能接着聊）',
          );
        if (!models.length)
          throw new HttpError(503, 'model_catalog_unavailable', '模型能力目录尚未就绪，请稍后重交');
        throw new HttpError(422, 'model_unavailable', '模型执行能力缺失或当前不可用：' + model);
      }
      return { models, environment };
    },

    record(runId, run, kind, data) {
      const seq = run.nextSeq++;
      if (kind === 'assistant_text' && !data.parentSessionId) run.lastText = String(data.text);
      // 根会话里的用户消息：开头那句之后来的是插话
      let interjection = false;
      if (kind === 'user_message' && !data.parentSessionId) {
        interjection = run.opening === 'heard';
        if (run.opening === 'sent') run.opening = 'heard';
      }
      const written = interjection ? { ...data, interjection } : data;
      run.writes = run.writes
        .then(() => repo.appendEvents(runId, [{ seq, kind, data: written }]))
        .catch((err: unknown) => logger.error({ err, runId, seq }, '写运行事件失败'));
    },

    async execute(row, request, run, catalog, recovering = false) {
      const { id } = row;
      const { models, environment } = catalog;
      // 在用户电脑上跑的不占云端沙箱的名额、不收算力钱
      const device = request.workplace.kind === 'device';
      const executor = ctx.executorOf({ payerId: row.payerId, workplace: request.workplace });
      const release = device ? () => undefined : await state.gate.acquire();
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
        summary: null,
      };
      const unavailable = (error: unknown) => error instanceof HttpError && error.statusCode >= 500;
      const suspend = (error: unknown) => {
        if (run.abort.signal.aborted) return;
        run.suspended = true;
        ctx.record(id, run, 'status', {
          status: 'recovery_wait',
          reason: '执行依赖暂不可用，等待接管',
        });
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
            conversationId: row.conversationId,
            domesticOnly: request.domesticOnly,
            askPaid: request.permissions.paidTools === 'ask',
            noWeb: request.permissions.web === false,
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
          keyId,
          keyTtlSeconds: deps.keyTtlSeconds ?? 6 * 3600,
          cores: device ? 0 : deps.cores,
          windowMs: deps.leaseMs ?? 5 * 60_000,
          onFailure: (error) => {
            if (unavailable(error)) suspend(error);
            else
              run.abort.abort(new StopRun('stopped', '运行租约续期失败，已停止：' + String(error)));
          },
        });
        stopped();

        const files = [
          ...runtimeFiles({ models, sessionId: row.sessionId ?? id, recovering, environment }),
          // 保证 out/ 目录存在且属于沙箱用户
          { path: `out/${KEEP_FILE}`, content: Buffer.alloc(0) },
        ];
        sandbox = await executor.start({
          runId: id,
          workspaceId: row.sessionId ?? id,
          // 接管或接着原会话：持久卷必须已经在，不能从空目录假装恢复
          restore: recovering || Boolean(row.continueFrom),
          cacheId: row.payerId,
          env: {
            ...deps.batchEnv,
            OASIS_TOOL_SCOPE: row.sessionId ?? id,
            ...sandboxEnv({
              runKey: key.key,
              model: row.model,
              place: device
                ? { permissions: request.permissions }
                : { modelBaseUrl: deps.modelBaseUrl, packages: deps.packages },
            }),
          },
          notify: (status) => ctx.record(id, run, 'status', { status }),
          files: [
            { dir: SANDBOX_PATHS.workdir, tar: await packFiles(files) },
            // 平台说明（带这个 AI 的人设）和技能每轮现放：改了说明，下一轮就用上
            {
              dir: SANDBOX_PATHS.dshHome,
              tar: await packFiles(
                guideFiles(
                  await deps.guide(),
                  request.persona,
                  request.workplace,
                  request.scene,
                  request.permissions.web !== false,
                ),
              ),
            },
            // oasis-tool 这些命令和 dsh 组合也每轮现放：改了，下一轮就用上，不用重建镜像
            ...(deps.sandboxFiles
              ? await Promise.all(
                  (await deps.sandboxFiles()).map(async ({ dir, files }) => ({
                    dir,
                    tar: await packFiles(files),
                  })),
                )
              : []),
            ...(recovering
              ? []
              : [
                  {
                    dir: SANDBOX_PATHS.workdir,
                    tar: packStreams(await ctx.materialFiles(request.materials, id, row.payerId)),
                  },
                ]),
          ],
        });
        const box = sandbox;
        const { put } = box;
        if (put) run.put = (tar) => put.call(box, SANDBOX_PATHS.workdir, tar);
        run.abort.signal.addEventListener(
          'abort',
          () => {
            const reason: unknown = run.abort.signal.reason;
            if (reason instanceof StopRun && reason.status !== 'cancelled') {
              // 停止：先把已经做出来的东西存下来，再销毁沙箱
              run.saved = box
                .pause()
                .then(() => ctx.save(box, id))
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

        const stderr = () => stderrTail;
        const { agent, failure } = await driveAgent({
          row,
          run,
          sandbox,
          recovering,
          stopped,
          stderr,
        });
        stopped();

        const saved = await ctx.save(sandbox, id, { companions: true });
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
          const box = sandbox;
          await box
            .pause()
            .then(() => ctx.save(box, id))
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
          ctx.record(id, run, 'status', {
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
              headers: { 'x-oasis-payer-id': row.payerId },
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
            .catch((err: unknown) =>
              logger.warn({ err, runId: id }, '作废临时 Key 失败，等它过期'),
            );
        }
        await settlement;
        release();
      }
      await run.writes;
      const control = state.controlRequests.get(id);
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
          summary: outcome.summary,
        });
      } else await ctx.finish(row, outcome);
      state.live.delete(id);
    },

    async finish(row, outcome) {
      await repo.finish(row.id, { ...outcome, finishedAt: new Date() });
      state.controlRequests.delete(row.id);
      logger.info(
        { runId: row.id, status: outcome.status, outputs: outcome.outputs.length },
        '运行结束',
      );
    },
  };
}
