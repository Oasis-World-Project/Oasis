// 登录校验与防跨站：在转发之前，为每个 /api 请求确定「当前用户是谁」。
import { createHash } from 'node:crypto';
import { IntrospectResult, SESSION_COOKIE } from '@oasis/contracts/identity';
import { HttpError, readCookie, type ServiceApp, type ServiceClient } from '@oasis/service-kit';

declare module 'fastify' {
  interface FastifyRequest {
    /** gateway 校验会话后得到的用户；未登录为 null */
    oasisUserId: string | null;
  }
}

/** 不需要登录就能调用的接口 */
const PUBLIC_ROUTES = new Set([
  'POST /api/identity/v1/auth/email-code',
  'POST /api/identity/v1/auth/verify',
  'POST /api/identity/v1/auth/logout',
]);
const LOGOUT_ROUTE = 'POST /api/identity/v1/auth/logout';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CACHE_LIMIT = 10_000;

export function registerAuth(
  app: ServiceApp,
  options: { identity: ServiceClient; allowedOrigins: Set<string>; cacheTtlMs: number },
): void {
  // 键是令牌的哈希，内存里不留明文令牌
  const cache = new Map<string, { userId: string; expiresAt: number }>();

  async function resolveUser(token: string, requestId: string): Promise<string | null> {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.userId;
    try {
      const { userId } = await options.identity.json('POST', '/internal/sessions/introspect', {
        body: { token },
        requestId,
        schema: IntrospectResult,
      });
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, { userId, expiresAt: Date.now() + options.cacheTtlMs });
      return userId;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 401) {
        cache.delete(key);
        return null;
      }
      throw err;
    }
  }

  app.decorateRequest('oasisUserId', null);

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const route = `${request.method} ${request.url.split('?')[0]}`;

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !options.allowedOrigins.has(origin)) {
        throw new HttpError(403, 'forbidden_origin', '请求来源不被允许');
      }
    }

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    request.oasisUserId = token ? await resolveUser(token, request.id) : null;
    if (route === LOGOUT_ROUTE && token)
      cache.delete(createHash('sha256').update(token).digest('hex'));
    if (!request.oasisUserId && !PUBLIC_ROUTES.has(route)) {
      throw new HttpError(401, 'unauthenticated', '请先登录');
    }
  });
}
