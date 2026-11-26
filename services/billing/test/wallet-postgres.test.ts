import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import type { Logger } from '@oasis/service-kit';
import { createWalletRepo } from '../src/repo/wallet-repo.ts';
import { createWalletService } from '../src/service/wallet-service.ts';
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
  it('金库：从钱包存进去，花的时候记着是谁叫的，解散时剩下的按存入比例退回（送的额度仍算送的），再解散一次不重复退', async () => {
    const service = createWalletService({
      repo,
      signupGrantMicro: 0,
      priceMultiplier: 1,
      holdTtlMs: 60_000,
      logger: { info: () => {} } as unknown as Logger,
    });
    const treasury = randomUUID(),
      a = randomUUID(),
      b = randomUUID();
    await repo.grantSignup(randomUUID(), a, 600);
    await repo.grantSignup(randomUUID(), b, 300);
    // 存多了不行；没存过的金库是空的
    await expect(service.deposit(treasury, a, 601)).rejects.toMatchObject({ statusCode: 402 });
    expect(await service.treasury(treasury)).toEqual({
      availableMicro: 0,
      depositedMicro: 0,
      spentMicro: 0,
      members: [],
    });
    await service.deposit(treasury, a, 600);
    await service.deposit(treasury, b, 300);
    expect((await repo.findWallet(a))?.balanceMicro).toBe(0);
    // b 叫 AI 花了 90，还有一笔没记是谁叫的（判断谁想接话）花了 10
    const hold = await service.hold({
      userId: treasury,
      actorId: b,
      amountMicro: 200,
      reason: 'run',
      ref: 'r1',
    });
    await service.settle(hold.holdId, 90);
    const judge = await service.hold({
      userId: treasury,
      amountMicro: 50,
      reason: 'judge',
      ref: 'r2',
    });
    await service.settle(judge.holdId, 10);
    const now = await service.treasury(treasury);
    expect(now).toMatchObject({ availableMicro: 800, depositedMicro: 900, spentMicro: 100 });
    expect([...now.members].sort((x, y) => y.depositedMicro - x.depositedMicro)).toEqual([
      { userId: a, depositedMicro: 600, spentMicro: 0 },
      { userId: b, depositedMicro: 300, spentMicro: 90 },
    ]);
    // 解散：800 按 2:1 退，零头给存得最多的
    const { refunds } = await service.dissolve(treasury);
    expect(refunds).toEqual([
      { userId: a, amountMicro: 534 },
      { userId: b, amountMicro: 266 },
    ]);
    expect((await repo.findWallet(a))?.balanceMicro).toBe(534);
    expect((await repo.findWallet(b))?.balanceMicro).toBe(266);
    expect((await service.dissolve(treasury)).refunds).toEqual([]);
    expect((await service.treasury(treasury)).availableMicro).toBe(0);
    // 解散了的金库不能再花
    await expect(
      service.hold({ userId: treasury, amountMicro: 1, reason: 'run', ref: 'r3' }),
    ).rejects.toMatchObject({ statusCode: 402 });
    // 解散时还冻结着的钱，退回来之后接着按比例退
    const late = randomUUID();
    await service.deposit(late, b, 100);
    const open = await service.hold({
      userId: late,
      actorId: b,
      amountMicro: 40,
      reason: 'run',
      ref: 'r4',
    });
    expect((await service.dissolve(late)).refunds).toEqual([{ userId: b, amountMicro: 60 }]);
    await service.settle(open.holdId, 10);
    await service.releaseExpired();
    expect((await repo.findWallet(late))?.balanceMicro).toBe(0);
    expect((await repo.findWallet(b))?.balanceMicro).toBe(266 - 100 + 60 + 30);
    // 退回来的仍算送的：a 再存进别的金库，流水上记着这 534 都是送的
    const other = randomUUID();
    await service.deposit(other, a, 534);
    const { rows } = await pool.query(
      "select detail->>'giftedMicro' gifted from ledger_entries where user_id=$1 and kind='transfer_in'",
      [other],
    );
    expect(rows).toEqual([{ gifted: '534' }]);
  });
});
