// 真实数据库：按账号 ID 查人的次数限制记在库里，开两份服务也只算一份；迁移能回退。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityRepo } from '../src/repo/identity-repo.ts';

const LOOKUPS = '20261118210000_profile_lookups.sql';

describe.skipIf(!process.env.TEST_DATABASE_URL)('查人的次数限制（真实数据库）', () => {
  const schema = 'identity_test_' + randomUUID().replaceAll('-', '');
  const pools = [0, 1].map(
    () =>
      new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      }),
  );
  const [pool] = pools as [pg.Pool, pg.Pool];
  /** 两份服务：各有各的连接池，连的是同一个库 */
  const [first, second] = pools.map((p) => createIdentityRepo(p)) as [
    ReturnType<typeof createIdentityRepo>,
    ReturnType<typeof createIdentityRepo>,
  ];
  const root = new URL('../migrations/', import.meta.url);
  const part = async (file: string, which: 'up' | 'down') => {
    const [, rest] = (await readFile(new URL(file, root), 'utf8')).split('-- migrate:up');
    const [up, down] = rest!.split('-- migrate:down');
    return which === 'up' ? up! : down!;
  };
  const user = async () =>
    (
      await pool.query<{ id: string }>(
        `insert into users (email, account_no, name) values ($1, $2, '测试') returning id`,
        [
          `${randomUUID()}@example.test`,
          String(10_000_000 + Math.floor(Math.random() * 89_999_999)),
        ],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort())
      await pool.query(await part(file, 'up'));
  });
  afterAll(async () => {
    await pool.query(`drop schema if exists ${schema} cascade`);
    await Promise.all(pools.map((p) => p.end()));
  });

  it('两份服务同时收到同一个人的 30 次查询：一共只放行 20 次；过了一分钟又能查；各人算各人的', async () => {
    const me = await user();
    const other = await user();
    const at = new Date('2026-11-18T12:00:00Z');
    const since = new Date(at.getTime() - 60_000);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).takeLookup(me, at, since, 20)),
    );
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await first.takeLookup(me, at, since, 20)).toBe(false);
    expect(await second.takeLookup(other, at, since, 20)).toBe(true);
    // 一分钟以后：之前那 20 次不算了，库里也不再留着
    const later = new Date(at.getTime() + 61_000);
    expect(await second.takeLookup(me, later, new Date(later.getTime() - 60_000), 20)).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      'select count(*) as n from profile_lookups where user_id = $1',
      [me],
    );
    expect(rows).toEqual([{ n: '1' }]);
  });

  it('迁移能回退：这张表去掉再建回来', async () => {
    await pool.query(await part(LOOKUPS, 'down'));
    await pool.query(await part(LOOKUPS, 'up'));
    expect(await first.takeLookup(await user(), new Date(), new Date(Date.now() - 60_000), 1)).toBe(
      true,
    );
  });
});
