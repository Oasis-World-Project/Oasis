import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createToolJobsRepo } from '../src/repo/tool-jobs-repo.ts';
import { createObjectStore } from '@oasis/service-kit';
import { createToolService } from '../src/service/tool-service.ts';
import { pino } from 'pino';

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
  it('取消迁移可在排空作业后回滚', async () => {
    const a = randomUUID(),
      b = randomUUID();
    for (const id of [a, b])
      await repo.insert({
        id,
        tool: 'render.fixture',
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
  it('任务删除与迟到插入并发时，要么拒绝准入，要么持久标记清理与取消', async () => {
    const taskId = randomUUID(),
      id = randomUUID();
    const make = (jobId: string) => ({
      id: jobId,
      tool: 'audio.music',
      providerJobId: 'fixture',
      call: { caller: { payerId, taskId, runId: randomUUID() } },
      requestKey: null,
      requestHash: null,
    });
    const outcomes = await Promise.allSettled([
      repo.insert(make(id)),
      repo.markTaskDeleted(taskId),
    ]);
    expect(outcomes[1]!.status).toBe('fulfilled');
    const row = await repo.get(id);
    if (row)
      expect(row.call).toMatchObject({
        taskDeleted: true,
        cancelRequested: true,
        taskFilesCleaned: false,
      });
    else expect(outcomes[0]!.status).toBe('rejected');
    expect(await repo.taskDeleted(taskId)).toBe(true);
    await expect(repo.insert(make(randomUUID()))).rejects.toThrow('fences');
    if (row) expect((await repo.deletedResults(100)).map((job) => job.id)).toContain(id);
  });
  it('删除先于首个工具调用也会被记住；删除迁移可回滚重建', async () => {
    const taskId = randomUUID();
    await repo.markTaskDeleted(taskId);
    await repo.markTaskDeleted(taskId);
    expect(await repo.taskDeleted(taskId)).toBe(true);
    await expect(
      repo.insert({
        id: randomUUID(),
        tool: 'audio.music',
        providerJobId: '',
        call: { caller: { payerId, taskId } },
        requestKey: null,
        requestHash: null,
      }),
    ).rejects.toThrow('fences');
    const migration = await readFile(
      new URL('../migrations/20261102130000_tool_task_deletions.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration.split('-- migrate:down')[1]!);
    await pool.query(migration.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    expect(await repo.taskDeleted(taskId)).toBe(false);
  });
  it.skipIf(!process.env.TEST_S3_ENDPOINT)(
    '真实对象存储随任务清除结果，重复清理不会重建对象',
    async () => {
      await pool.query("update tool_jobs set status='failed',phase='failed'");
      const taskId = randomUUID(),
        id = randomUUID(),
        key = `tool-results/${id}/0`;
      const objects = createObjectStore({
        endpoint: process.env.TEST_S3_ENDPOINT!,
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket: process.env.S3_BUCKET ?? 'oasis-model-gateway',
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
      });
      const store = objects.store;
      const tools = createToolService({
        jobs: repo,
        store,
        logger: pino({ level: 'silent' }),
        jobTimeoutMs: 60000,
      } as Parameters<typeof createToolService>[0]);
      try {
        await objects.ensureBucket();
        await store.put(key, Buffer.alloc(128 * 1024, 57), 'application/octet-stream');
        await repo.insert({
          id,
          tool: 'fixture.media',
          providerJobId: 'fixture',
          call: { caller: { payerId, taskId }, resultFileIds: ['0'] },
          requestKey: null,
          requestHash: null,
        });
        await repo.update(id, {
          result: {
            tool: 'fixture.media',
            text: 'fixture',
            files: [
              {
                id: '0',
                name: 'fixture.bin',
                mediaType: 'application/octet-stream',
                base64: '',
                size: 128 * 1024,
              },
            ],
            costMicro: 0,
          },
          cost: { costMicro: 0, source: 'provider' },
        });
        await repo.finish(id, 'completed');
        expect((await store.get(key)).length).toBe(128 * 1024);
        await tools.purgeTask(taskId);
        await tools.purgeTask(taskId);
        await expect(store.get(key)).rejects.toThrow();
        expect(await repo.get(id)).toMatchObject({
          status: 'completed',
          phase: 'expired',
          result: null,
          cost: { costMicro: 0 },
        });
      } finally {
        await tools.close();
        await store.delete(key);
        await objects.resource.close();
      }
    },
  );
});
