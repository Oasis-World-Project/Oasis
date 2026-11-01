// 实时数字人会话（ADR 0013）：开会话、结束、查看，以及后台清扫。
// 开：登记会话 → 按最长时长冻结 → 签会话专用临时 Key → 在 LiveAvatar 上存秘钥、建大模型配置和人设 → 开会话。
//     每建好一样就记进 resources，中途失败或服务崩溃，清扫都能拆干净。
// 结束：先标记结束并通知 LiveAvatar 停下（用户不用等）；拆资源、结算交给清扫在后台做。
// 结算：按 LiveAvatar 报告的实际消耗积分 × 单价；查不到时等一会儿再按分钟估算。沙箱不收钱。
import { randomUUID } from 'node:crypto';
import {
  AvatarSessionStartBody,
  type AvatarSessionStarted,
  type AvatarSessionView,
  type AvatarSpec,
  type AvatarTurn,
} from '@oasis/contracts/avatar';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { z } from 'zod';
import { LiveAvatarError, type LiveAvatarClient } from '../adapters/liveavatar.ts';
import type { AvatarSession, AvatarSessionsRepo } from '../repo/avatar-sessions-repo.ts';
import type { CallsRepo } from '../repo/calls-repo.ts';
import type { AvatarResources } from '../repo/schema.ts';
import type { Meter } from './metering.ts';
import type { RunKeyService } from './run-key-service.ts';

/** 沙箱只能用官方测试形象 */
export const SANDBOX_AVATAR_ID = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
/** FULL 模式每分钟 2 积分 */
const CREDITS_PER_MINUTE = 2;
/** 临时 Key 和冻结都比会话多留一会儿，够最后一轮说完、够清扫结算 */
const KEY_GRACE_SECONDS = 600;
const HOLD_GRACE_MS = 30 * 60_000;
/** 开始了这么久还没开成，就当失败收尾 */
const STARTING_TIMEOUT_MS = 5 * 60_000;
/** 过了最长时长这么久还在「进行中」，就强制结束 */
const OVERRUN_MS = 2 * 60_000;
/** 结束这么久还查不到实际消耗，就按分钟估算 */
const SETTLE_FALLBACK_MS = 10 * 60_000;
/**
 * LiveAvatar 每分钟扫一遍活动会话扣积分，会话记录里的 credits_consumed 在结束后还会补涨
 * （实测：结束 14 秒时报 1，几分钟后变成 2.2）。结束满 3 分钟才按它结算。
 */
const PROVIDER_SETTLE_DELAY_MS = 3 * 60_000;

type StartInput = z.output<typeof AvatarSessionStartBody>;

/** 供应商的错误只进日志；给调用方的是能看懂的说法 */
function providerError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof LiveAvatarError && err.status === 402) {
    return new HttpError(503, 'avatar_no_credits', '数字人服务的额度用完了');
  }
  return new HttpError(502, 'avatar_provider_error', '数字人服务暂时连不上，请稍后再试');
}

/** 套餐对单次时长有上限（免费档 120 秒）：从 LiveAvatar 的报错里读出允许的秒数 */
function planLimitSeconds(err: unknown): number | undefined {
  if (!(err instanceof LiveAvatarError) || err.status !== 400) return undefined;
  const match = /maximum allowed \((\d+)\s*s\)/i.exec(err.message);
  return match ? Number(match[1]) : undefined;
}

/** 删除时对方说「没有这个」也算删掉了 */
const gone = (err: unknown) => err instanceof LiveAvatarError && err.status === 404;

function toView(row: AvatarSession): AvatarSessionView {
  return {
    sessionId: row.id,
    status: row.status,
    sandbox: row.sandbox,
    maxSeconds: row.maxSeconds,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    turns: row.turns,
    pricePerMinuteMicro: row.pricePerMinuteMicro,
    chargedMicro: row.settledAt ? (row.chargedMicro ?? 0) : null,
  };
}

export function createAvatarService(deps: {
  client: LiveAvatarClient;
  runKeys: RunKeyService;
  repo: AvatarSessionsRepo;
  calls: CallsRepo;
  meter: Meter;
  /** LiveAvatar 回调我们大模型的公网地址（到 /avatar/v1 为止） */
  publicBaseUrl: string | undefined;
  model: string;
  /** 开发期：所有会话都用沙箱（不扣积分，只有官方测试形象） */
  sandbox: boolean;
  /** 每个 LiveAvatar 积分多少钱（微美元） */
  creditMicro: number;
  sweepMs: number;
  logger: Logger;
  now?: () => Date;
}) {
  const { client, runKeys, repo, logger } = deps;
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;

  /** 按调用记录还原计量信息再结算（同算力结算） */
  async function settleCall(callId: string, costMicro: number, source: 'provider' | 'estimate') {
    const row = await deps.calls.get(callId);
    if (!row?.holdId || row.status !== 'running') return;
    await deps.meter.settle(
      {
        id: row.id,
        holdId: row.holdId,
        requestId: row.requestId ?? callId,
        model: row.model,
        kind: 'avatar',
        caller: {
          payerId: row.payerId,
          ...(row.runId ? { runId: row.runId } : {}),
          ...(row.taskId ? { taskId: row.taskId } : {}),
        },
      },
      { costMicro, source },
      undefined,
    );
  }

  /** 拆掉在 LiveAvatar 上建的东西、作废临时 Key；全部成功才记「已清理」 */
  async function cleanup(row: AvatarSession): Promise<void> {
    const r: AvatarResources = row.resources;
    const steps: [string, (() => Promise<void>) | undefined][] = [
      ['context', r.contextId ? () => client.deleteContext(r.contextId as string) : undefined],
      [
        'llm-configuration',
        r.llmConfigurationId
          ? () => client.deleteLlmConfiguration(r.llmConfigurationId as string)
          : undefined,
      ],
      ['secret', r.secretId ? () => client.deleteSecret(r.secretId as string) : undefined],
      ['run-key', r.runKeyId ? () => runKeys.revoke(r.runKeyId as string) : undefined],
    ];
    const results = await Promise.allSettled(
      steps.map(async ([what, run]) => {
        try {
          await run?.();
        } catch (err) {
          if (gone(err)) return;
          logger.warn({ err, sessionId: row.id, what }, '数字人会话清理失败，下次清扫再试');
          throw err;
        }
      }),
    );
    if (results.every((x) => x.status === 'fulfilled')) await repo.markCleaned(row.id, now());
  }

  /** 结算：沙箱或没冻结的记 0；否则优先按 LiveAvatar 报告的消耗积分。顺便按它的记录更正结束原因 */
  async function settle(row: AvatarSession): Promise<void> {
    let info: Record<string, unknown> | undefined;
    if (row.resources.providerSessionId) {
      try {
        info = await client.getSession(row.resources.providerSessionId);
      } catch (err) {
        logger.warn({ err, sessionId: row.id }, '查不到数字人会话的详情，稍后再试');
      }
    }
    if (info?.end_at && typeof info.end_reason === 'string' && info.end_reason !== row.endReason) {
      await repo.setEndReason(row.id, info.end_reason);
    }
    if (!row.callId || row.sandbox || !row.startedAt) {
      if (row.callId) await settleCall(row.callId, 0, 'estimate');
      await repo.markSettled(row.id, 0, now());
      return;
    }
    const providerEnd = info?.end_at ? Date.parse(`${String(info.end_at)}Z`) : Number.NaN;
    const settledDown =
      Number.isFinite(providerEnd) && now().getTime() - providerEnd >= PROVIDER_SETTLE_DELAY_MS;
    if (info?.end_at && !settledDown) return; // LiveAvatar 还在补记消耗，下次清扫再结
    const credits =
      settledDown && typeof info?.credits_consumed === 'number' ? info.credits_consumed : undefined;
    let costMicro: number;
    let source: 'provider' | 'estimate';
    if (credits !== undefined) {
      costMicro = Math.round(credits * deps.creditMicro);
      source = 'provider';
    } else if ((row.endedAt?.getTime() ?? 0) < now().getTime() - SETTLE_FALLBACK_MS) {
      const end = row.endedAt ?? now();
      const seconds = Math.min(
        row.maxSeconds,
        Math.max(0, (end.getTime() - row.startedAt.getTime()) / 1000),
      );
      costMicro = Math.max(1, Math.ceil(seconds / 60)) * row.pricePerMinuteMicro;
      source = 'estimate';
    } else {
      return; // 还没等到实际消耗，下次再结
    }
    await settleCall(row.callId, costMicro, source);
    await repo.markSettled(row.id, costMicro, now());
    logger.info({ sessionId: row.id, costMicro, source }, '数字人会话已结算');
  }

  /** 收尾一个会话：该结束的结束，已结束的拆资源、结算 */
  async function finish(row: AvatarSession): Promise<void> {
    let current: AvatarSession | undefined = row;
    const t = now().getTime();
    if (current.status === 'starting' && current.createdAt.getTime() < t - STARTING_TIMEOUT_MS) {
      current = await repo.end(current.id, 'START_FAILED', now());
    } else if (current.status === 'live' && current.resources.providerSessionId) {
      const deadline = (current.startedAt?.getTime() ?? t) + current.maxSeconds * 1000 + OVERRUN_MS;
      let endReason: string | undefined;
      let endedAt = now();
      if (t > deadline) {
        endReason = 'MAX_DURATION_REACHED';
        await client.stopSession(current.resources.providerSessionId).catch(() => {});
      } else {
        // LiveAvatar 那边可能已经结束了（关了页面、长时间不说话、额度用完）
        const info = await client
          .getSession(current.resources.providerSessionId)
          .catch(() => undefined);
        if (info?.end_at) {
          endReason = typeof info.end_reason === 'string' ? info.end_reason : 'UNKNOWN';
          const parsed = Date.parse(`${String(info.end_at)}Z`);
          if (Number.isFinite(parsed)) endedAt = new Date(parsed);
        }
      }
      if (endReason) current = await repo.end(current.id, endReason, endedAt);
    }
    if (current?.status !== 'ended') return;
    if (!current.cleanedAt) await cleanup(current);
    if (!current.settledAt) await settle(current);
  }

  async function sweep(): Promise<void> {
    const rows = await repo.unfinished(50);
    for (const row of rows) {
      try {
        await finish(row);
      } catch (err) {
        logger.warn({ err, sessionId: row.id }, '数字人会话收尾失败，下次清扫再试');
      }
    }
  }

  /** 后台收尾一个会话（不让请求等） */
  function finishLater(id: string) {
    void (async () => {
      const row = await repo.get(id);
      if (row) await finish(row);
    })().catch((err: unknown) => logger.warn({ err, sessionId: id }, '数字人会话收尾失败'));
  }

  return {
    async start(payerId: string, input: StartInput): Promise<AvatarSessionStarted> {
      if (!client.configured) {
        throw new HttpError(503, 'avatar_not_configured', '数字人服务还没有配置好');
      }
      if (!deps.publicBaseUrl) {
        throw new HttpError(503, 'avatar_entry_not_configured', '数字人的公网入口还没有配置');
      }
      const spec: AvatarSpec = input.spec;
      const id = randomUUID();
      const sandbox = deps.sandbox;
      let maxSeconds = spec.maxMinutes * 60;
      const pricePerMinuteMicro = sandbox ? 0 : CREDITS_PER_MINUTE * deps.creditMicro;
      await repo.create({
        id,
        payerId,
        artifactId: input.artifactId ?? null,
        taskId: input.taskId ?? null,
        sandbox,
        maxSeconds,
        pricePerMinuteMicro,
        spec,
      });
      try {
        if (pricePerMinuteMicro > 0) {
          // 额度不够时 billing 返回 402，原样交给调用方
          const call = await deps.meter.hold({
            caller: { payerId, runId: id, ...(input.taskId ? { taskId: input.taskId } : {}) },
            kind: 'avatar',
            model: 'liveavatar-full',
            amountMicro: spec.maxMinutes * pricePerMinuteMicro,
            requestId: id,
            ttlMs: maxSeconds * 1000 + HOLD_GRACE_MS,
          });
          await repo.setCall(id, call.id);
        }
        const key = await runKeys.issue({
          payerId,
          runId: id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ttlSeconds: maxSeconds + KEY_GRACE_SECONDS,
        });
        await repo.addResources(id, { runKeyId: key.keyId });
        const secretId = await client.createSecret(`oasis-avatar-${id}`, key.key);
        await repo.addResources(id, { secretId });
        const llmConfigurationId = await client.createLlmConfiguration({
          name: `oasis-avatar-${id}`,
          model: deps.model,
          secretId,
          baseUrl: deps.publicBaseUrl,
        });
        await repo.addResources(id, { llmConfigurationId });
        const contextId = await client.createContext({
          name: spec.name,
          prompt: spec.prompt,
          openingText: spec.openingText,
        });
        await repo.addResources(id, { contextId });
        const tokenFor = (seconds: number) =>
          client.createSessionToken({
            avatarId: sandbox ? SANDBOX_AVATAR_ID : spec.avatarId,
            ...(spec.voiceId && !sandbox ? { voiceId: spec.voiceId } : {}),
            contextId,
            language: spec.language,
            llmConfigurationId,
            sandbox,
            maxSeconds: seconds,
          });
        let token: Awaited<ReturnType<typeof tokenFor>>;
        try {
          token = await tokenFor(maxSeconds);
        } catch (err) {
          // 套餐不允许这么长（免费档单次最长 120 秒）：按允许的时长再开一次
          const limit = planLimitSeconds(err);
          if (!limit || limit >= maxSeconds) throw err;
          maxSeconds = limit;
          await repo.setMaxSeconds(id, limit);
          token = await tokenFor(limit);
        }
        await repo.addResources(id, { providerSessionId: token.providerSessionId });
        const room = await client.startSession(token.sessionToken);
        const startedAt = now();
        await repo.markLive(id, startedAt);
        logger.info(
          { sessionId: id, providerSessionId: token.providerSessionId, sandbox },
          '数字人会话已开始',
        );
        return {
          sessionId: id,
          livekitUrl: room.livekitUrl,
          livekitToken: room.livekitToken,
          sandbox,
          maxSeconds,
          pricePerMinuteMicro,
          startedAt: startedAt.toISOString(),
        };
      } catch (err) {
        logger.warn({ err, sessionId: id }, '数字人会话没开成，后台拆掉已建好的部分');
        await repo.end(id, 'START_FAILED', now());
        finishLater(id);
        throw providerError(err);
      }
    },

    /** 结束：只能结束自己的会话；重复结束不报错。拆资源和结算在后台做 */
    async stop(payerId: string, sessionId: string, reason = 'USER_CLOSED'): Promise<void> {
      const row = await repo.get(sessionId);
      if (row?.payerId !== payerId) return;
      const ended = await repo.end(sessionId, reason, now());
      if (!ended) return;
      if (ended.resources.providerSessionId) {
        await client.stopSession(ended.resources.providerSessionId).catch((err: unknown) => {
          logger.warn({ err, sessionId }, '通知 LiveAvatar 结束会话失败（它会按最长时长自己结束）');
        });
      }
      logger.info({ sessionId }, '数字人会话已结束');
      finishLater(sessionId);
    },

    async view(payerId: string, sessionId: string): Promise<AvatarSessionView> {
      const row = await repo.get(sessionId);
      if (row?.payerId !== payerId)
        throw new HttpError(404, 'avatar_session_not_found', '没有这个数字人会话');
      return toView(row);
    },

    /** 公网入口用：正在进行的会话（会话编号就是临时 Key 的 runId） */
    async liveSession(sessionId: string | undefined): Promise<AvatarSession | undefined> {
      if (!sessionId) return undefined;
      const row = await repo.get(sessionId);
      return row?.status === 'live' ? row : undefined;
    },

    recordTurn: (sessionId: string, turn: AvatarTurn) => repo.appendTurn(sessionId, turn),

    sweep,

    startSweeper() {
      timer = setInterval(() => {
        sweeping ??= sweep()
          .catch((err: unknown) => logger.warn({ err }, '数字人会话清扫失败'))
          .finally(() => {
            sweeping = undefined;
          });
      }, deps.sweepMs);
      timer.unref();
    },

    async close(): Promise<void> {
      clearInterval(timer);
      await sweeping;
    },
  };
}

export type AvatarService = ReturnType<typeof createAvatarService>;
