import {
  AccountNo,
  AvatarBody,
  IntrospectBody,
  ProfilesBody,
  RequestCodeBody,
  SESSION_COOKIE,
  UpdateProfileBody,
  VerifyCodeBody,
} from '@oasis/contracts/identity';
import { z } from 'zod';
import { parseWith, readCookie, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { AuthService } from '../service/auth-service.ts';
import type { ProfileService } from '../service/profile-service.ts';

const UserId = z.object({ id: z.uuid() });
const Lookup = z.object({ accountNo: AccountNo });

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
  profiles: ProfileService,
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

  // ---- 资料 ----
  app.put('/v1/me/profile', async (request) =>
    profiles.update(requireUserId(request), parseWith(UpdateProfileBody, request.body)),
  );
  app.put('/v1/me/avatar', async (request) => {
    const { type, data } = parseWith(AvatarBody, request.body);
    return profiles.setAvatar(requireUserId(request), type, data);
  });
  app.delete('/v1/me/avatar', async (request) => profiles.clearAvatar(requireUserId(request)));
  // 头像地址带着版本号（?v=），换了头像就是新地址，所以可以一直缓存
  app.get('/v1/users/:id/avatar', async (request, reply) => {
    requireUserId(request);
    const avatar = await profiles.avatar(parseWith(UserId, request.params).id);
    return reply
      .header('content-type', avatar.type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(avatar.content);
  });
  app.get('/v1/users/lookup', async (request) =>
    profiles.lookup(requireUserId(request), parseWith(Lookup, request.query).accountNo),
  );
  app.post('/v1/users/profiles', async (request) => {
    requireUserId(request);
    return { profiles: await profiles.profiles(parseWith(ProfilesBody, request.body).ids) };
  });
  // 只给别的服务用（conversation 要成员和好友的名字、头像）
  app.post('/internal/profiles', async (request) => ({
    profiles: await profiles.profiles(parseWith(ProfilesBody, request.body).ids),
  }));

  // 只给 gateway 用：会话令牌换用户 ID
  app.post('/internal/sessions/introspect', async (request) => {
    const { token } = parseWith(IntrospectBody, request.body);
    return auth.introspect(token);
  });
}
