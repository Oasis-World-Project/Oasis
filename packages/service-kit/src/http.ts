// 每个服务的 HTTP 外壳：统一探针、请求 ID、错误格式。
// /health 只表示进程活着；/ready 表示依赖全部可用；/v1/meta 说明当前运行的版本。
import { randomUUID } from 'node:crypto';
import type { ErrorBody, HealthBody, MetaBody, ReadyBody } from '@oasis/contracts/common';
import Fastify, { LogController, type FastifyError } from 'fastify';
import type { Logger } from './logger.ts';
import type { ServiceResource } from './resource.ts';

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_PATHS = new Set(['/health', '/ready']);

interface HttpServerOptions {
  service: string;
  version: string;
  commit: string;
  logger: Logger;
  resources: readonly ServiceResource[];
  isShuttingDown: () => boolean;
}

export function errorBody(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, requestId } };
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 没有响应`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpServer(options: HttpServerOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    requestIdHeader: 'x-request-id',
    // 探针每几秒就被调一次，不记请求日志
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: (request) => PROBE_PATHS.has(request.url),
    }),
    genReqId: () => randomUUID(),
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorBody('not_found', '没有这个接口', request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, '请求处理失败');
      reply.code(status).send(errorBody('internal_error', '服务内部错误', request.id));
      return;
    }
    reply.code(status).send(errorBody(error.code ?? 'bad_request', error.message, request.id));
  });

  app.get('/health', async (): Promise<HealthBody> => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const checks: ReadyBody['checks'] = {};
    await Promise.all(
      options.resources.map(async (resource) => {
        try {
          await withTimeout(resource.ready(), PROBE_TIMEOUT_MS);
          checks[resource.name] = 'ok';
        } catch (err) {
          checks[resource.name] = 'failed';
          app.log.warn({ err, resource: resource.name }, '依赖未就绪');
        }
      }),
    );
    const ready = !options.isShuttingDown() && Object.values(checks).every((c) => c === 'ok');
    const body: ReadyBody = { status: ready ? 'ready' : 'not_ready', checks };
    return reply.code(ready ? 200 : 503).send(body);
  });

  app.get('/v1/meta', async (): Promise<MetaBody> => ({
    service: options.service,
    version: options.version,
    commit: options.commit,
  }));

  return app;
}

export type ServiceApp = ReturnType<typeof createHttpServer>;
