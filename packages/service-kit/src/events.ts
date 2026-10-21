// 服务之间的异步事件（NATS JetStream）：发布、确保 stream 存在、持久化消费。
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  JetStreamApiCodes,
  JetStreamApiError,
  jetstreamManager,
  type ConsumerMessages,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import { EventEnvelope } from '@oasis/contracts/events';
import type { Logger } from './logger.ts';
import type { ServiceResource } from './resource.ts';

const SECOND_NS = 1_000_000_000;

interface StreamSpec {
  readonly name: string;
  readonly subjects: readonly string[];
}

export function createEnvelope(source: string, type: string, data: unknown): EventEnvelope {
  return { id: randomUUID(), type, source, time: new Date().toISOString(), data };
}

/** 事件的所有者服务在启动时调用：没有就建，有就更新主题列表。 */
export async function ensureStream(connection: NatsConnection, stream: StreamSpec): Promise<void> {
  const jsm = await jetstreamManager(connection);
  const subjects = [...stream.subjects];
  try {
    await jsm.streams.info(stream.name);
    await jsm.streams.update(stream.name, { subjects });
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound))
      throw err;
    // 2 分钟内同一个事件 ID 只收一次：发件箱重复投递时由 JetStream 去重
    await jsm.streams.add({ name: stream.name, subjects, duplicate_window: 120 * SECOND_NS });
  }
}

export async function publishEvent(
  connection: NatsConnection,
  envelope: EventEnvelope,
): Promise<void> {
  await jetstream(connection).publish(envelope.type, JSON.stringify(envelope), {
    msgID: envelope.id,
  });
}

/**
 * 持久化消费某个 stream 的事件。处理成功才确认；失败 5 秒后重投，最多 20 次。
 * handle 必须幂等（同一事件可能投递多次）。stream 暂时不存在时每 2 秒重试，不阻塞启动。
 */
export function startEventConsumer(options: {
  connection: NatsConnection;
  stream: StreamSpec;
  durable: string;
  filterSubject: string;
  logger: Logger;
  handle: (envelope: EventEnvelope) => Promise<void>;
}): ServiceResource {
  const { connection, stream, durable, logger } = options;
  let stopped = false;
  let messages: ConsumerMessages | undefined;

  const loop = (async () => {
    while (!stopped) {
      try {
        const jsm = await jetstreamManager(connection);
        await jsm.consumers.add(stream.name, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.All,
          filter_subject: options.filterSubject,
          ack_wait: 30 * SECOND_NS,
          max_deliver: 20,
        });
        const consumer = await jetstream(connection).consumers.get(stream.name, durable);
        messages = await consumer.consume();
        for await (const message of messages) {
          try {
            await options.handle(EventEnvelope.parse(message.json()));
            message.ack();
          } catch (err) {
            logger.error(
              { err, subject: message.subject, seq: message.seq },
              '事件处理失败，稍后重投',
            );
            message.nak(5_000);
          }
        }
      } catch (err) {
        if (stopped) break;
        logger.warn({ err, stream: stream.name, durable }, '事件消费暂不可用，2 秒后重试');
      }
      messages = undefined;
      if (!stopped) await delay(2_000);
    }
  })();

  return {
    name: `consumer:${durable}`,
    async ready() {
      if (!messages) throw new Error(`还没有开始消费 ${stream.name}`);
    },
    async close() {
      stopped = true;
      messages?.stop();
      await loop;
    },
  };
}
