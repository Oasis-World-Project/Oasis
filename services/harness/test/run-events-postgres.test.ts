// 真实数据库：契约里的每一种运行事件都存得进 run_events（表上的取值范围和契约对得上）。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunEventKind } from '@oasis/contracts/harness';
import { createRunsRepo } from '../src/repo/runs-repo.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('运行事件（真实数据库）', () => {
  const schema = `run_events_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, migrations), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
  });
  afterAll(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });

  it('契约里的每一种事件都存得进去、读得出来', async () => {
    const repo = createRunsRepo(pool);
    const id = randomUUID();
    await repo.insert({
      id,
      payerId: randomUUID(),
      conversationId: randomUUID(),
      model: 'test/model',
      prompt: '写个网页',
    });
    const kinds = RunEventKind.options;
    await repo.appendEvents(
      id,
      kinds.map((kind, index) => ({ seq: index + 1, kind, data: {} })),
    );
    expect((await repo.listEvents(id, 0, 100)).map((event) => event.kind)).toEqual(kinds);
  });
});
