// 邮箱验证码登录的业务规则：频率限制、尝试次数、注册事件、会话。
import { UserRegistered } from '@oasis/contracts/events';
import type { MeBody } from '@oasis/contracts/identity';
import { createEnvelope, HttpError } from '@oasis/service-kit';
import type { IdentityRepo, User } from '../repo/identity-repo.ts';
import {
  codeMatches,
  generateCode,
  generateSessionToken,
  hashCode,
  hashSessionToken,
  normalizeEmail,
} from './codes.ts';

export const AUTH_LIMITS = {
  codeTtlMs: 10 * 60_000,
  resendCooldownMs: 60_000,
  maxCodesPerHour: 5,
  maxAttempts: 5,
  touchSessionEveryMs: 60 * 60_000,
} as const;

export interface LoginCodeSender {
  send(email: string, code: string): Promise<void>;
}

function toMe(user: User): MeBody {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export function createAuthService(deps: {
  repo: IdentityRepo;
  sender: LoginCodeSender;
  pepper: string;
  sessionTtlDays: number;
  serviceName: string;
  now?: () => Date;
}) {
  const { repo, sender, pepper } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async requestCode(rawEmail: string): Promise<void> {
      const email = normalizeEmail(rawEmail);
      const current = now();
      const recent = await repo.recentCodes(email, new Date(current.getTime() - 60 * 60_000));
      const last = recent[0];
      if (last && current.getTime() - last.createdAt.getTime() < AUTH_LIMITS.resendCooldownMs) {
        const wait = Math.ceil(
          (AUTH_LIMITS.resendCooldownMs - (current.getTime() - last.createdAt.getTime())) / 1000,
        );
        throw new HttpError(429, 'too_many_requests', `请 ${wait} 秒后再获取验证码`);
      }
      if (recent.length >= AUTH_LIMITS.maxCodesPerHour) {
        throw new HttpError(429, 'too_many_requests', '验证码获取太频繁，请一小时后再试');
      }
      const code = generateCode();
      const codeId = await repo.insertCode({
        email,
        codeHash: hashCode(pepper, email, code),
        expiresAt: new Date(current.getTime() + AUTH_LIMITS.codeTtlMs),
      });
      try {
        await sender.send(email, code);
      } catch (err) {
        await repo.deleteCode(codeId);
        throw new HttpError(503, 'mail_unavailable', '验证码邮件暂时发不出去，请稍后再试', {
          cause: err,
        });
      }
    },

    async verify(rawEmail: string, code: string) {
      const email = normalizeEmail(rawEmail);
      const current = now();
      const active = await repo.latestActiveCode(email, current);
      if (!active) throw new HttpError(400, 'invalid_code', '验证码不对或已过期');
      if (active.attempts >= AUTH_LIMITS.maxAttempts) {
        throw new HttpError(429, 'too_many_attempts', '错误次数太多，请重新获取验证码');
      }
      if (!codeMatches(active.codeHash, pepper, email, code)) {
        await repo.addAttempt(active.id);
        throw new HttpError(400, 'invalid_code', '验证码不对或已过期');
      }
      const token = generateSessionToken();
      const signedIn = await repo.consumeCodeAndSignIn({
        codeId: active.id,
        email,
        session: {
          tokenHash: hashSessionToken(token),
          expiresAt: new Date(current.getTime() + deps.sessionTtlDays * 86_400_000),
        },
        registeredEvent: (userId, registeredAt) =>
          createEnvelope(deps.serviceName, UserRegistered.type, {
            userId,
            registeredAt: registeredAt.toISOString(),
          }),
      });
      if (!signedIn) throw new HttpError(400, 'invalid_code', '验证码不对或已过期');
      return { token, user: toMe(signedIn.user), isNewUser: signedIn.isNewUser };
    },

    async introspect(token: string): Promise<{ userId: string }> {
      const tokenHash = hashSessionToken(token);
      const current = now();
      const session = await repo.findSession(tokenHash, current);
      if (!session) throw new HttpError(401, 'unauthenticated', '会话无效或已过期');
      const staleBefore = new Date(current.getTime() - AUTH_LIMITS.touchSessionEveryMs);
      if (session.lastSeenAt < staleBefore)
        await repo.touchSession(tokenHash, current, staleBefore);
      return { userId: session.userId };
    },

    async logout(token: string): Promise<void> {
      await repo.deleteSession(hashSessionToken(token));
    },

    async me(userId: string): Promise<MeBody> {
      const user = await repo.findUser(userId);
      if (!user) throw new HttpError(401, 'unauthenticated', '账号不存在');
      return toMe(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
