// 事务发件箱：业务数据和要发出的事件在同一个数据库事务里写入，再由后台把事件投递到 JetStream。
// 服务崩溃也不会丢事件；重复投递由 JetStream 按事件 ID 去重，消费方也必须幂等。
//
// 使用发件箱的服务要在自己的库里建这张表（列名固定）：
//   create table outbox (
//     id uuid primary key, subject text not null, payload jsonb not null,
//     created_at timestamptz not null default now(), published_at timestamptz
//   );
//   create index outbox_unpublished on outbox (created_at) where published_at is null;
import type { NatsConnection } from '@nats-io/transport-node';
import type { EventEnvelope } from '@oasis/contracts/events';
import type pg from 'pg';
import { publishEvent } from './events.ts';
import type { Logger } from './logger.ts';
import type { ServiceResource } from './resource.ts';

export function startOutboxRelay(options: {
  pool: pg.Pool;
  connection: NatsConnection;
  logger: Logger;
  intervalMs?: number;
}): ServiceResource {
  const { pool, connection, logger, intervalMs = 500 } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  async function relayOnce(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string; payload: EventEnvelope }>(
        'select id, payload from outbox where published_at is null order by created_at limit 50 for update skip locked',
      );
      for (const row of rows) await publishEvent(connection, row.payload);
      if (rows.length > 0) {
        await client.query('update outbox set published_at = now() where id = any($1::uuid[])', [
          rows.map((row) => row.id),
        ]);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      logger.warn({ err }, '发件箱投递失败，稍后重试');
    } finally {
      client.release();
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = relayOnce().finally(schedule);
    }, intervalMs);
  }
  schedule();

  return {
    name: 'outbox',
    async ready() {},
    async close() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
