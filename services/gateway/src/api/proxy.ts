// 只转发 /api/<服务>/v1/* → <服务>/v1/*；上游的 /health、/ready、/internal/* 从外面访问不到。
import httpProxy from '@fastify/http-proxy';
import { errorBody, type ServiceApp } from '@oasis/service-kit';
import { PUBLIC_SERVICES, type GatewayConfig } from '../config.ts';

/** x-oasis-* 头只能由 gateway 写入（第 4 阶段用来传递已认证的用户），客户端带来的一律丢弃。 */
const INTERNAL_HEADER_PREFIX = 'x-oasis-';

type PublicService = keyof typeof PUBLIC_SERVICES;

export async function registerProxies(app: ServiceApp, config: GatewayConfig): Promise<void> {
  for (const service of Object.keys(PUBLIC_SERVICES) as PublicService[]) {
    await app.register(httpProxy, {
      upstream: config[PUBLIC_SERVICES[service]],
      prefix: `/api/${service}/v1`,
      rewritePrefix: '/v1',
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => ({
          ...Object.fromEntries(
            Object.entries(headers).filter(([name]) => !name.startsWith(INTERNAL_HEADER_PREFIX)),
          ),
          'x-request-id': request.id,
        }),
        onError: (reply, { error }) => {
          reply.log.warn({ err: error, upstream: service }, '上游服务不可用');
          reply
            .code(503)
            .send(errorBody('upstream_unavailable', `${service} 服务暂时不可用`, reply.request.id));
        },
      },
    });
  }
}
