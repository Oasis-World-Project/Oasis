// 真实数据库：开几份服务时要一起认的两件事——隔一会儿的那一遍只让一份做；「这个群有人开着」哪一份上连着都算。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLeases } from '../src/repo/leases.ts';
import { scratchSchema } from './support/schema.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('几份服务一起认的租约', () => {
  const { pool, create, drop } = scratchSchema('leases_test');
  /** 两份服务（这里共用一个连接池，认的都是库里那一行） */
  const first = createLeases(pool),
    second = createLeases(pool);
  beforeAll(create);
  afterAll(drop);

  it('隔一会儿的那一遍：这段时间里只有一份拿得到，时间到了才有下一次', async () => {
    const name = `rounds-${randomUUID()}`;
    const got = await Promise.all([
      first.tick(name, 300),
      second.tick(name, 300),
      first.tick(name, 300),
    ]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await second.tick(name, 300)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await second.tick(name, 300)).toBe(true);
    expect(await first.tick(name, 300)).toBe(false);
  });

  it('有人开着这个群：一份服务记下，另一份也认；到时没再记就不算了；过期很久的清掉', async () => {
    const watched = randomUUID(),
      quiet = randomUUID();
    expect(await second.alive(watched)).toBe(false);
    await first.touch([watched], 300);
    await first.touch([], 300);
    expect(await second.alive(watched)).toBe(true);
    expect(await second.alive(quiet)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await second.alive(watched)).toBe(false);
    await pool.query(
      "update conversation_locks set expires_at = now() - interval '2 hours' where key = $1",
      [`watch:${watched}`],
    );
    await first.prune();
    const { rowCount } = await pool.query('select 1 from conversation_locks where key = $1', [
      `watch:${watched}`,
    ]);
    expect(rowCount).toBe(0);
  });
});
