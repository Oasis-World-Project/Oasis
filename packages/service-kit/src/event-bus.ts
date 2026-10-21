// NATS 事件总线连接。断线自动重连；首次连不上时持续重试，而不是直接退出。
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { z } from 'zod';
import type { Logger } from './logger.ts';
import type { ServiceResource } from './resource.ts';

export const eventBusEnv = {
  NATS_URL: z.string().min(1),
  NATS_USER: z.string().min(1),
  NATS_PASSWORD: z.string().min(1),
};

type EventBusConfig = { [K in keyof typeof eventBusEnv]: string };

export interface EventBusResource extends ServiceResource {
  readonly connection: NatsConnection;
}

const QUIET_STATUS = new Set(['ping', 'reconnecting']);
/** 正常关闭时也会出现的状态，不算异常 */
const EXPECTED_STATUS = new Set(['close', 'reconnect']);

export async function connectEventBus(
  config: EventBusConfig,
  clientName: string,
  logger: Logger,
): Promise<EventBusResource> {
  const connection = await connect({
    servers: config.NATS_URL,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
    name: clientName,
    waitOnFirstConnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2_000,
  });
  void (async () => {
    for await (const status of connection.status()) {
      if (QUIET_STATUS.has(status.type)) continue;
      const level = EXPECTED_STATUS.has(status.type) ? 'info' : 'warn';
      logger[level]({ status: status.type }, 'NATS 连接状态变化');
    }
  })();
  return {
    name: 'nats',
    connection,
    async ready() {
      if (connection.isClosed()) throw new Error('NATS 连接已关闭');
      await connection.flush();
    },
    async close() {
      if (!connection.isClosed()) await connection.drain();
    },
  };
}
