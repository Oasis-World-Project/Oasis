import { HttpError } from '@oasis/service-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import type { NewRunKey, RunKey, RunKeysRepo } from '../src/repo/run-keys-repo.ts';
import { createRunKeyService } from '../src/service/run-key-service.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const RUN = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const TASK = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';

/** 内存里的 Key 表，行为与 SQL 版一致（只按未作废、未过期查）。 */
function memoryRepo(): RunKeysRepo & { rows: RunKey[] } {
  const rows: RunKey[] = [];
  return {
    rows,
    async insert(key: NewRunKey) {
      rows.push({
        ...key,
        taskId: key.taskId ?? null,
        nodeId: key.nodeId ?? null,
        revokedAt: null,
        createdAt: new Date(),
      });
    },
    async findActive(keyHash, now) {
      return rows.find((r) => r.keyHash === keyHash && !r.revokedAt && r.expiresAt > now);
    },
    async revoke(id, now) {
      const row = rows.find((r) => r.id === id && !r.revokedAt);
      if (row) row.revokedAt = now;
      return Boolean(row);
    },
  };
}

let clock = new Date('2026-10-22T10:00:00Z');
let repo: ReturnType<typeof memoryRepo>;
let service: ReturnType<typeof createRunKeyService>;
beforeEach(() => {
  clock = new Date('2026-10-22T10:00:00Z');
  repo = memoryRepo();
  service = createRunKeyService({ repo, now: () => clock });
});

describe('运行临时 Key', () => {
  it('签发的 Key 能换出付费人和归属；库里只存哈希', async () => {
    const issued = await service.issue({
      payerId: PAYER,
      runId: RUN,
      taskId: TASK,
      ttlSeconds: 60,
    });
    expect(issued.key).toMatch(/^oasis_run_[\w-]{40,}$/);
    expect(repo.rows[0]?.keyHash).not.toContain(issued.key);
    await expect(service.authenticate(`Bearer ${issued.key}`)).resolves.toEqual({
      payerId: PAYER,
      runId: RUN,
      taskId: TASK,
    });
  });

  it('作废、过期、格式不对、没带 Key 都是 401', async () => {
    const a = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
    await service.revoke(a.keyId);
    await service.revoke(a.keyId); // 幂等
    const b = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
    clock = new Date(clock.getTime() + 61_000);
    for (const header of [`Bearer ${a.key}`, `Bearer ${b.key}`, 'Bearer sk-or-xxx', undefined]) {
      const err = await service.authenticate(header).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(401);
    }
  });
});
