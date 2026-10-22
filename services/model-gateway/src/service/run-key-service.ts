// 每次 agent 运行专用的临时 Key：签发（明文只返回一次）、校验（换出付费人和归属）、作废。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RunKeyCreated } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import type { RunKeysRepo } from '../repo/run-keys-repo.ts';
import type { Caller } from './metering.ts';

/** Key 的前缀方便在日志、泄漏扫描里认出来；后面是 32 字节随机数 */
const PREFIX = 'oasis_run_';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function createRunKeyService(deps: { repo: RunKeysRepo; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    async issue(input: Caller & { runId: string; ttlSeconds: number }) {
      const key = `${PREFIX}${randomBytes(32).toString('base64url')}`;
      const keyId = randomUUID();
      const expiresAt = new Date(now().getTime() + input.ttlSeconds * 1000);
      await deps.repo.insert({
        id: keyId,
        keyHash: hashKey(key),
        payerId: input.payerId,
        runId: input.runId,
        taskId: input.taskId ?? null,
        nodeId: input.nodeId ?? null,
        expiresAt,
      });
      return { keyId, key, expiresAt: expiresAt.toISOString() } satisfies RunKeyCreated;
    },

    /** 从 Authorization 头换出调用方；Key 不存在、已作废或已过期一律 401。 */
    async authenticate(authorization: string | undefined): Promise<Caller> {
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const row = key.startsWith(PREFIX)
        ? await deps.repo.findActive(hashKey(key), now())
        : undefined;
      if (!row) throw new HttpError(401, 'invalid_run_key', '运行凭证无效或已过期');
      return {
        payerId: row.payerId,
        runId: row.runId,
        ...(row.taskId ? { taskId: row.taskId } : {}),
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
      };
    },

    /** 作废是幂等的：重复作废、作废不存在的 Key 都不报错。 */
    async revoke(keyId: string): Promise<void> {
      await deps.repo.revoke(keyId, now());
    },
  };
}

export type RunKeyService = ReturnType<typeof createRunKeyService>;
