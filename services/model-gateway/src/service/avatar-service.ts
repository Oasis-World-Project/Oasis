// 实时数字人会话（ADR 0013）：在 LiveAvatar 上建好「回调我们大模型」的配置和人设，开会话；结束时全部拆掉。
// 每个会话一把临时 Key：LiveAvatar 每轮对话带着它调公网入口，大模型的花费照常记到付费人身上。
// 5.10a 只在内存里登记会话（服务重启会丢）；落库、按分钟结算和清扫在 5.10b。
import { randomUUID } from 'node:crypto';
import type { AvatarSessionStartBody, AvatarSessionStarted } from '@oasis/contracts/model-gateway';
import type { z } from 'zod';
import { HttpError, type Logger } from '@oasis/service-kit';
import { LiveAvatarError, type LiveAvatarClient } from '../adapters/liveavatar.ts';
import type { RunKeyService } from './run-key-service.ts';

/** 临时 Key 比会话多活 10 分钟，够最后一轮回答说完 */
const KEY_GRACE_SECONDS = 600;

type Cleanup = { what: string; run: () => Promise<void> };

interface LiveSession {
  id: string;
  payerId: string;
  providerSessionId: string;
  cleanups: Cleanup[];
}

/** 供应商的错误只进日志；给调用方的是能看懂的说法 */
function providerError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof LiveAvatarError && err.status === 402) {
    return new HttpError(503, 'avatar_no_credits', '数字人服务的额度用完了');
  }
  return new HttpError(502, 'avatar_provider_error', '数字人服务暂时连不上，请稍后再试');
}

export function createAvatarService(deps: {
  client: LiveAvatarClient;
  runKeys: RunKeyService;
  /** LiveAvatar 回调我们大模型的公网地址（到 /avatar/v1 为止） */
  publicBaseUrl: string | undefined;
  model: string;
  logger: Logger;
}) {
  const { client, runKeys, logger } = deps;
  const sessions = new Map<string, LiveSession>();

  /** 倒序拆掉已经建好的东西；单项失败只记日志，不影响其余 */
  async function runCleanups(cleanups: Cleanup[], sessionId: string) {
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup.run();
      } catch (err) {
        logger.warn({ err, sessionId, what: cleanup.what }, '数字人会话清理失败');
      }
    }
  }

  return {
    async start(
      payerId: string,
      input: z.output<typeof AvatarSessionStartBody>,
    ): Promise<AvatarSessionStarted> {
      if (!client.configured) {
        throw new HttpError(503, 'avatar_not_configured', '数字人服务还没有配置好');
      }
      if (!deps.publicBaseUrl) {
        throw new HttpError(503, 'avatar_entry_not_configured', '数字人的公网入口还没有配置');
      }
      const id = randomUUID();
      const { sandbox } = input;
      const cleanups: Cleanup[] = [];
      try {
        const key = await runKeys.issue({
          payerId,
          runId: id,
          ttlSeconds: input.maxSeconds + KEY_GRACE_SECONDS,
        });
        cleanups.push({ what: 'run-key', run: () => runKeys.revoke(key.keyId) });
        const secretId = await client.createSecret(`oasis-avatar-${id}`, key.key);
        cleanups.push({ what: 'secret', run: () => client.deleteSecret(secretId) });
        const llmId = await client.createLlmConfiguration({
          name: `oasis-avatar-${id}`,
          model: deps.model,
          secretId,
          baseUrl: deps.publicBaseUrl,
        });
        cleanups.push({
          what: 'llm-configuration',
          run: () => client.deleteLlmConfiguration(llmId),
        });
        const contextId = await client.createContext({
          name: input.name,
          prompt: input.prompt,
          openingText: input.openingText,
        });
        cleanups.push({ what: 'context', run: () => client.deleteContext(contextId) });
        const token = await client.createSessionToken({
          avatarId: input.avatarId,
          ...(input.voiceId ? { voiceId: input.voiceId } : {}),
          contextId,
          language: input.language,
          llmConfigurationId: llmId,
          sandbox,
          maxSeconds: input.maxSeconds,
        });
        const room = await client.startSession(token.sessionToken);
        // 先停会话，再拆配置（倒序执行，所以最后放进去）
        cleanups.push({ what: 'session', run: () => client.stopSession(token.providerSessionId) });
        sessions.set(id, { id, payerId, providerSessionId: token.providerSessionId, cleanups });
        logger.info(
          { sessionId: id, providerSessionId: token.providerSessionId, sandbox },
          '数字人会话已开始',
        );
        return {
          sessionId: id,
          providerSessionId: token.providerSessionId,
          livekitUrl: room.livekitUrl,
          livekitToken: room.livekitToken,
          sandbox,
          maxSeconds: input.maxSeconds,
        };
      } catch (err) {
        logger.warn({ err, sessionId: id }, '数字人会话没开成，拆掉已建好的部分');
        await runCleanups(cleanups, id);
        throw providerError(err);
      }
    },

    /** 结束是幂等的：不存在或已结束的会话直接返回；只能结束自己的会话 */
    async stop(payerId: string, sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session || session.payerId !== payerId) return;
      sessions.delete(sessionId);
      await runCleanups(session.cleanups, sessionId);
      logger.info({ sessionId }, '数字人会话已结束');
    },

    /** 服务关闭时结束所有会话，免得 LiveAvatar 上留下没人管的会话和配置 */
    async close(): Promise<void> {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.all(all.map((s) => runCleanups(s.cleanups, s.id)));
    },

    /** 公网入口只认正在进行的数字人会话的 Key（会话编号就是 Key 的 runId） */
    isActive: (sessionId: string | undefined) => Boolean(sessionId && sessions.has(sessionId)),
    active: () => sessions.size,
  };
}

export type AvatarService = ReturnType<typeof createAvatarService>;
