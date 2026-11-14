// 只转发 /api/<服务>/v1/* → <服务>/v1/*；上游的 /health、/ready、/internal/* 从外面访问不到。
// 另有两条给「在用户电脑上干活」：桌面版连 harness（/api/harness/v1/devices，WebSocket，照常认人），
// 电脑上的 dsh 调模型和工具（/api/run/v1 → model-gateway /run/v1，只认这一轮的临时 Key）。
import httpProxy from '@fastify/http-proxy';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { errorBody, type ServiceApp } from '@oasis/service-kit';
import type { FastifyRequest } from 'fastify';
import { PUBLIC_SERVICES, type GatewayConfig } from '../config.ts';
import { RUN_PREFIX } from './auth.ts';

/** x-oasis-* 头只能由 gateway 写入，客户端带来的一律丢弃。 */
const INTERNAL_HEADER_PREFIX = 'x-oasis-';
/** dsh 调模型的流式输出可能隔很久才有下一段（和沙箱入口代理一样等 10 分钟） */
const RUN_TIMEOUT_MS = 600_000;

type PublicService = keyof typeof PUBLIC_SERVICES;

/** 转给上游的头：丢掉客户端带来的 x-oasis-*，写上请求号和（登录了的）用户；cookie 只在 keepCookie 时留着 */
function forwardHeaders(
  request: Pick<FastifyRequest, 'id' | 'oasisUserId'>,
  headers: Record<string, unknown>,
  keepCookie: boolean,
) {
  const forwarded: Record<string, unknown> = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !name.startsWith(INTERNAL_HEADER_PREFIX) && (name !== 'cookie' || keepCookie),
    ),
  );
  forwarded[OASIS_HEADERS.requestId] = request.id;
  if (request.oasisUserId) forwarded[OASIS_HEADERS.userId] = request.oasisUserId;
  return forwarded;
}

export async function registerProxies(app: ServiceApp, config: GatewayConfig): Promise<void> {
  const proxy = async (
    service: string,
    options: { upstream: string; prefix: string; rewritePrefix: string; keepCookie?: boolean },
    extra: Record<string, unknown> = {},
  ) =>
    app.register(httpProxy, {
      upstream: options.upstream,
      prefix: options.prefix,
      rewritePrefix: options.rewritePrefix,
      replyOptions: {
        rewriteRequestHeaders: (request, headers) =>
          forwardHeaders(request, headers, Boolean(options.keepCookie)) as typeof headers,
        onError: (reply, { error }) => {
          reply.log.warn({ err: error, upstream: service }, '上游服务不可用');
          reply
            .code(503)
            .send(errorBody('upstream_unavailable', `${service} 服务暂时不可用`, reply.request.id));
        },
      },
      ...extra,
    });

  for (const service of Object.keys(PUBLIC_SERVICES) as PublicService[])
    // 会话 Cookie 只交给 identity，其他服务拿不到会话令牌
    await proxy(service, {
      upstream: config[PUBLIC_SERVICES[service]],
      prefix: `/api/${service}/v1`,
      rewritePrefix: '/v1',
      keepCookie: service === 'identity',
    });

  await proxy(
    'model-gateway',
    { upstream: config.MODEL_GATEWAY_URL, prefix: RUN_PREFIX, rewritePrefix: '/run/v1' },
    { undici: { headersTimeout: RUN_TIMEOUT_MS, bodyTimeout: RUN_TIMEOUT_MS } },
  );

  await proxy(
    'harness',
    {
      upstream: config.HARNESS_URL,
      prefix: '/api/harness/v1/devices',
      rewritePrefix: '/v1/devices',
    },
    {
      websocket: true,
      // 升级成 WebSocket 的请求也先过登录校验（auth.ts）；转给 harness 时只带是谁，不带 Cookie
      wsClientOptions: {
        rewriteRequestHeaders: (_headers: object, request: FastifyRequest) =>
          forwardHeaders(request, {}, false),
      },
    },
  );
}
