import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createWalletRepo } from '../src/repo/wallet-repo.ts';
describe.skipIf(!process.env.TEST_DATABASE_URL)('真实 PostgreSQL 冻结续期和结算恢复', () => {
  const schema = 'billing_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const repo = createWalletRepo(pool),
    payer = randomUUID();
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const root = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
    await repo.grantSignup(randomUUID(), payer, 1000000);
  });
  afterAll(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });
  it('续期不会新增冻结；旧过期扫描不能释放已续期的 hold', async () => {
    const now = new Date(),
      old = new Date(now.getTime() + 1000);
    const hold = await repo.createHold({
      userId: payer,
      amountMicro: 100,
      reason: 'test',
      ref: 'renew',
      expiresAt: old,
    });
    expect(await repo.renewHold(hold!.id, now, new Date(now.getTime() + 600000))).toBe(true);
    expect(await repo.releaseHold(hold!.id, new Date(now.getTime() + 2000))).toBe(false);
    expect((await repo.findWallet(payer))?.heldMicro).toBe(100);
    await repo.releaseHold(hold!.id);
    expect(await repo.renewHold(hold!.id, now, new Date(now.getTime() + 600000))).toBe(false);
  });
  it('相同成本的结算重试只扣一次；不接受不同成本', async () => {
    const hold = await repo.createHold({
      userId: payer,
      amountMicro: 100,
      reason: 'test',
      ref: 'settle',
      expiresAt: new Date(Date.now() + 60000),
    });
    expect(await repo.settleHold(hold!.id, 75, { costMicro: 75 })).toBe(75);
    expect(await repo.settleHold(hold!.id, 75, { costMicro: 75 })).toBe(75);
    expect(await repo.settleHold(hold!.id, 76, { costMicro: 76 })).toBeUndefined();
    expect((await repo.findWallet(payer))?.balanceMicro).toBe(999925);
    expect((await repo.findWallet(payer))?.heldMicro).toBe(0);
  });
});
