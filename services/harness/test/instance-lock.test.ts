// 真实数据库：一台机器只跑一个 harness——第二份占不到锁就等，前一份退出后接手。
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { holdInstanceLock } from '../src/service/instance-lock.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('harness 的实例锁（真实数据库）', () => {
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  const logger = pino({ level: 'silent' });

  it('第一份占着时第二份一直等；第一份退出后第二份占到，能正常收尾', async () => {
    const name = `test-${randomUUID()}`;
    const first = await holdInstanceLock({ databaseUrl, logger, name, retryMs: 20 });
    await first.ready();
    let secondHeld = false;
    const second = holdInstanceLock({ databaseUrl, logger, name, retryMs: 20 }).then((lock) => {
      secondHeld = true;
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondHeld).toBe(false);
    await first.close();
    const lock = await second;
    expect(secondHeld).toBe(true);
    await lock.ready();
    await lock.close();
  });

  it('正常收尾不当成「连接断了」（连接真断了才告诉调用方，线上是退出进程让编排重启）', async () => {
    let lost = 0;
    const lock = await holdInstanceLock({
      databaseUrl,
      logger,
      name: `test-${randomUUID()}`,
      onLost: () => (lost += 1),
    });
    await lock.close();
    expect(lost).toBe(0);
  });
});
