import {
  IntrospectBody,
  RequestCodeBody,
  SESSION_COOKIE,
  VerifyCodeBody,
} from '@oasis/contracts/identity';
import { parseWith, readCookie, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { AuthService } from '../service/auth-service.ts';

function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function registerRoutes(
  app: ServiceApp,
  auth: AuthService,
  cookie: { secure: boolean; ttlDays: number },
): void {
  app.post('/v1/auth/email-code', async (request, reply) => {
    const { email } = parseWith(RequestCodeBody, request.body);
    await auth.requestCode(email);
    return reply.code(204).send();
  });

  app.post('/v1/auth/verify', async (request, reply) => {
    const { email, code } = parseWith(VerifyCodeBody, request.body);
    const result = await auth.verify(email, code);
    reply.header('set-cookie', sessionCookie(result.token, cookie.ttlDays * 86_400, cookie.secure));
    return { user: result.user, isNewUser: result.isNewUser };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) await auth.logout(token);
    reply.header('set-cookie', sessionCookie('', 0, cookie.secure));
    return reply.code(204).send();
  });

  app.get('/v1/me', async (request) => auth.me(requireUserId(request)));

  // 只给 gateway 用：会话令牌换用户 ID
  app.post('/internal/sessions/introspect', async (request) => {
    const { token } = parseWith(IntrospectBody, request.body);
    return auth.introspect(token);
  });
}
