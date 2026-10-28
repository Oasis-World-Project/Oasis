import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createToolJobsRepo } from '../src/repo/tool-jobs-repo.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('真实 PostgreSQL 取消准入事务', () => {
  const schema = 'render_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const repo = createToolJobsRepo(pool),
    runId = randomUUID(),
    payerId = randomUUID();
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const root = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
  });
  afterAll(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });
  it('取消先到会阻止后续插入，错误付费人不能取消', async () => {
    await repo.cancelRun(runId, payerId);
    await expect(
      repo.insert({
        id: randomUUID(),
        tool: '3d.render',
        providerJobId: '',
        call: { caller: { runId, payerId } },
        requestKey: null,
        requestHash: null,
      }),
    ).rejects.toThrow('fences');
    await expect(repo.cancelRun(runId, randomUUID())).rejects.toThrow('owner');
  });
  it('插入和取消并发：要么拒绝插入，要么已有作业带持久取消意图', async () => {
    const run = randomUUID(),
      id = randomUUID();
    const results = await Promise.allSettled([
      repo.insert({
        id,
        tool: '3d.render',
        providerJobId: '',
        call: { caller: { runId: run, payerId } },
        requestKey: null,
        requestHash: null,
      }),
      repo.cancelRun(run, payerId),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    const row = await repo.get(id);
    if (row) expect(row.call.cancelRequested).toBe(true);
    else expect(results[0]!.status).toBe('rejected');
    await expect(
      repo.insert({
        id: randomUUID(),
        tool: '3d.render',
        providerJobId: '',
        call: { caller: { runId: run, payerId } },
        requestKey: null,
        requestHash: null,
      }),
    ).rejects.toThrow();
    if (row) await repo.finish(id, 'failed');
  });
  it('同一云 profile 在对账结束前只接纳一个作业', async () => {
    const a = randomUUID(),
      b = randomUUID();
    const make = (id: string) => ({
      id,
      tool: '3d.render',
      providerJobId: '',
      call: { caller: { payerId } },
      requestKey: null,
      requestHash: null,
    });
    expect(await repo.insert(make(a))).toBe(true);
    await expect(repo.insert(make(b))).rejects.toThrow('profile busy');
    await repo.finish(a, 'completed');
    expect(await repo.insert(make(b))).toBe(true);
    await repo.finish(b, 'failed');
  });
  it('已占用的账单窗口跨完成状态保留；补账观察到期或退避后不挤占扫描', async () => {
    const id = randomUUID(),
      end = (Math.floor(Date.now() / 3600000) + 2) * 3600000;
    await repo.insert({
      id,
      tool: '3d.render',
      providerJobId: '',
      call: { caller: { payerId } },
      requestKey: null,
      requestHash: null,
    });
    await repo.mergeCall(id, { autoAudit: { windowEnd: end, watchUntil: Date.now() + 60000 } });
    await repo.finish(id, 'completed');
    expect(await repo.renderWindowEnd(randomUUID())).toBe(end);
    expect(await repo.renderWindowEnd(id)).toBeLessThan(end);
    expect((await repo.pending(100)).some((row) => row.id === id)).toBe(true);
    await repo.mergeCall(id, { nextCheckAt: Date.now() + 60000 });
    expect((await repo.pending(100)).some((row) => row.id === id)).toBe(false);
    await repo.mergeCall(id, {
      nextCheckAt: 0,
      autoAudit: { windowEnd: end, watchUntil: Date.now() - 1 },
    });
    expect((await repo.pending(100)).some((row) => row.id === id)).toBe(false);
  });
  it('取消迁移可在排空作业后回滚', async () => {
    const a = randomUUID(),
      b = randomUUID();
    for (const id of [a, b])
      await repo.insert({
        id,
        tool: 'audit.fixture',
        providerJobId: '',
        call: { caller: { payerId } },
        requestKey: null,
        requestHash: null,
      });
    await repo.mergeCall(a, { billingEvidence: { billId: 'unique-bill-line' } });
    await expect(
      repo.mergeCall(b, { billingEvidence: { billId: 'unique-bill-line' } }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    const migration = await readFile(
      new URL('../migrations/20261028100000_create_tool_run_controls.sql', import.meta.url),
      'utf8',
    );
    await pool.query('delete from tool_jobs');
    await pool.query(migration.split('-- migrate:down')[1]!);
    await pool.query(migration.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
  });
});
