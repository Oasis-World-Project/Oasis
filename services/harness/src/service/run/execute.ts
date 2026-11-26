// 执行一轮：排队 → 找这份会话干活的地方（hosts.ts）：空着的还能用就接着用（Key 改归这一轮、放进这一轮
// 带来的文件）；不然签发临时 Key、起沙箱（挂上这个会话的持久工作目录）、放入平台说明、技能和用户发的
// 文件、dsh 握手、接着原会话 → 交用户的话 → 记录事件 → 等这一轮做完（期间可插话）→ 给 Word/PPT 配 PDF、
// 记下 out/ 的清单 → 结算算力 → 写结局。做完的地方留着等下一轮；停下、出错的收掉（销毁沙箱、作废 Key）。
// 依赖暂时不可用时保存原会话，等接管（control.ts）。
import { asksBefore } from '@oasis/contracts/harness';
import { ExecutionModels, RunKeyCreated } from '@oasis/contracts/model-gateway';
import { HttpError, packStreams } from '@oasis/service-kit';
import { SANDBOX_PATHS, type AgentConnection } from '../../adapter/dsh.ts';
import type { RunOutcome } from '../../repo/runs-repo.ts';
import { startRunLease } from '../run-lease.ts';
import type { Host, Hosts, Relay } from './hosts.ts';
import { savedOutcome, StopRun, type LiveRun, type RunContext } from './shared.ts';

/** 服务重启接管时交给 AI 的话：原会话和工作目录已恢复，接着做 */
const RECOVERED = '服务连接中断后已恢复原工作目录和原会话。请从未完成处继续，不重做已有工作。';

export function createExecution(
  ctx: RunContext,
  hosts: Hosts,
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
      const workspaceId = row.sessionId ?? id;
      // 在用户电脑上跑的不占云端沙箱的名额、不收算力钱
      const device = request.workplace.kind === 'device';
      const idleMs = device ? deps.idleMs.device : deps.idleMs.cloud;
      const executor = ctx.executorOf({ payerId: row.payerId, workplace: request.workplace });
      const release = device ? () => undefined : await state.gate.acquire();
      let host: Host | undefined;
      let keyId: string | undefined;
      let keyRevoked = false;
      let checkpointFailed = false;
      let sandboxEndedAt: number | undefined;
      // 算力计费：开沙箱前冻结，按这一轮用了多久结算（单价为 0 时没有 callId）
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
      const revoke = (key: string) =>
        deps.modelGateway.json('POST', `/internal/run-keys/${key}/revoke`, {
          body: {},
          requestId: id,
        });
      try {
        const stopped = () => {
          const reason: unknown = run.abort.signal.reason;
          if (run.abort.signal.aborted)
            throw reason instanceof StopRun ? reason : new StopRun('cancelled', '已取消');
        };
        stopped();
        await repo.update(id, { status: 'starting', error: null });

        const settings = {
          runId: id,
          domesticOnly: request.domesticOnly,
          askPaid: asksBefore('tool', request.workplace, request.permissions),
          noWeb: request.permissions.web === false,
          ttlSeconds: deps.keyTtlSeconds ?? 6 * 3600,
        };
        const fixed = await hosts.fixture(row, request, catalog, recovering);
        // 接管的一轮不接着用：服务重启后原来的 dsh 已经不在了
        host = recovering ? undefined : await hosts.take(workspaceId, fixed.signature);
        if (host) {
          // 接着用：它手里的 Key 改归这一轮；Key 已经过期就收掉，重起一个
          const rebound = await deps.modelGateway
            .json('POST', `/internal/run-keys/${host.keyId}/rebind`, {
              body: settings,
              requestId: id,
            })
            .then(
              () => true,
              (err: unknown) => {
                if (err instanceof HttpError && err.statusCode === 409) return false;
                throw err;
              },
            );
          if (!rebound) {
            await hosts.close(host);
            host = undefined;
          }
        }
        const key = host
          ? undefined
          : await deps.modelGateway.json('POST', '/internal/run-keys', {
              body: { ...settings, payerId: row.payerId, conversationId: row.conversationId },
              requestId: id,
              schema: RunKeyCreated,
            });
        keyId = host?.keyId ?? key?.keyId;
        if (!keyId) throw new Error('没有拿到临时 Key');
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

        const materials = recovering
          ? undefined
          : await ctx.materialFiles(request.materials, id, row.payerId);
        const record: Relay['to'] = (kind, data) => ctx.record(id, run, kind, data);
        let greeting: { setup: string; unsaid: boolean } | undefined;
        let stderr = () => '';
        const reused = Boolean(host);
        if (host) {
          host.relay.to = record;
          if (materials?.length)
            await host.sandbox.put(SANDBOX_PATHS.workdir, packStreams(materials));
        } else if (key) {
          const opened = await hosts.open({
            row,
            executor,
            fixed,
            key,
            restore: recovering || Boolean(row.continueFrom),
            ...(materials ? { materials } : {}),
            relay: { to: record },
          });
          ({ host, stderr } = opened);
        }
        if (!host) throw new Error('没有干活的地方');
        const { sandbox: box, agent } = host;
        run.put = (tar) => box.put(SANDBOX_PATHS.workdir, tar);
        run.abort.signal.addEventListener(
          'abort',
          () => {
            agent.abort(new Error('运行已中止'));
            const reason: unknown = run.abort.signal.reason;
            if (reason instanceof StopRun && reason.status !== 'cancelled') {
              // 停止：先记下已经做出来的东西，再销毁沙箱
              run.saved = box
                .pause()
                .then(() => ctx.save(row))
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
        // 沙箱启动期间就被取消或停止了：上面的监听来不及收到，这里补上（finally 会收掉这个地方）
        stopped();
        await repo.update(id, {
          containerId: box.id,
          status: 'running',
          startedAt: row.startedAt ?? new Date(),
        });

        if (!reused) greeting = await hosts.greet({ row, host, recovering, stopped, stderr });
        run.prompts += 1;
        run.opening = 'sent';
        await agent.prompt(
          (recovering && !greeting?.unsaid ? RECOVERED : row.prompt) + (greeting?.setup ?? ''),
        );
        // 插话排在开头那句后面：AI 还没开始时先到的按顺序送完，之后来的直接送
        while (run.queued.length) {
          run.prompts += 1;
          await agent.prompt(run.queued.shift()!);
        }
        run.agent = agent;
        const failure = await settle(run, agent);
        stopped();

        const saved = await ctx.save(row, box);
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
              logger.warn({ err: saveErr, runId: id }, '停止时没能列出产出');
              outcome.error = '已停止，但没能列出已经做出的文件（文件还在工作目录里）';
              return {};
            });
            Object.assign(outcome, savedOutcome(saved));
          }
        } else {
          logger.error({ err, runId: id }, '运行失败');
          outcome.error = err instanceof Error ? err.message : String(err);
        }
      } finally {
        if (host && outcome.status === 'failed' && !run.abort.signal.aborted) {
          const box = host.sandbox;
          await box
            .pause()
            .then(() => ctx.save(row))
            .then((saved) => Object.assign(outcome, savedOutcome(saved)))
            .catch((err: unknown) => logger.warn({ err, runId: id }, '失败时保存进度失败'));
        }
        clearTimeout(timer);
        run.closing = true;
        outcome.summary = run.lastText ?? null;
        // 做完了、dsh 还好好的：留着等这份会话的下一轮；别的情况（停下、出错、等接管）收掉
        const parked = Boolean(
          host &&
          idleMs > 0 &&
          outcome.status === 'succeeded' &&
          !run.abort.signal.aborted &&
          host.agent.alive(),
        );
        if (host && parked) hosts.park(host, idleMs);
        else if (host && (await hosts.stop(host))) sandboxEndedAt ??= Date.now();
        const endedAt = sandboxEndedAt ?? Date.now();
        if (run.suspended && sandboxEndedAt !== undefined)
          ctx.record(id, run, 'status', {
            status: 'suspended',
            endedAt: new Date(endedAt).toISOString(),
            cores: deps.cores,
            keyId: keyId ?? null,
          });
        const settlement = lease
          ?.close(endedAt, !host || parked || sandboxEndedAt !== undefined)
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
        if (keyId && !parked) {
          await revoke(keyId)
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
