// 一台机器只跑一个 harness：它管的是这台机器上的沙箱容器和每个会话的工作目录，运行也是按「单实例、
// 重启后接管」写的（run/control.ts）。启动时在数据库里占一把锁（一条专用连接上的 advisory lock），
// 占不到就等：更新版本时新的一份等旧的退出再接手；误开第二份时它一直起不来。
// 以后沙箱不够用是加机器、每台一个 harness（各连各的库或各占各的锁），见《架构》。
import type { Logger, ServiceResource } from '@oasis/service-kit';
import pg from 'pg';

/** 锁的名字（换成 bigint 给 advisory lock 用） */
const LOCK = 'oasis-harness-instance';

export async function holdInstanceLock(input: {
  databaseUrl: string;
  logger: Logger;
  /** 锁的名字：同一个库里同名的只有一份占得到（测试里换成各自的名字） */
  name?: string;
  /** 占不到时隔多久再试 */
  retryMs?: number;
  /** 占着锁的连接断了：这一份不能再当自己是唯一的，退出让编排重启（测试里换掉） */
  onLost?: () => void;
}): Promise<ServiceResource> {
  const { logger, retryMs = 2000 } = input;
  const client = new pg.Client({ connectionString: input.databaseUrl });
  let closing = false;
  const lost = (err?: unknown) => {
    if (closing) return;
    logger.fatal({ err }, '占着实例锁的数据库连接断了，退出');
    (input.onLost ?? (() => process.exit(1)))();
  };
  client.on('error', lost);
  client.on('end', () => lost());
  await client.connect();
  for (let waited = 0; ; waited += retryMs) {
    const { rows } = await client.query<{ held: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as held',
      [input.name ?? LOCK],
    );
    if (rows[0]?.held) break;
    if (waited % 10_000 === 0) logger.info('另一份 harness 还在跑，等它退出后接手');
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return {
    name: 'instance-lock',
    ready: async () => {
      await client.query('select 1');
    },
    close: async () => {
      closing = true;
      await client.end();
    },
  };
}
