import { describe, expect, it } from 'vitest';
import type { EmailCode, IdentityRepo, User } from '../src/repo/identity-repo.ts';
import { AUTH_LIMITS, createAuthService } from '../src/service/auth-service.ts';
import { codeMatches, hashCode, normalizeEmail } from '../src/service/codes.ts';

const PEPPER = 'test-pepper-0123456789';

/** 内存版仓库：只实现这些测试用到的行为。 */
function memoryRepo() {
  const codes: EmailCode[] = [];
  const users: User[] = [];
  const sessions = new Map<string, { userId: string; expiresAt: Date; lastSeenAt: Date }>();
  const events: unknown[] = [];
  let seq = 0;
  const repo: IdentityRepo = {
    recentCodes: async (email, since) =>
      codes
        .filter((c) => c.email === email && c.createdAt > since)
        .sort((a, b) => +b.createdAt - +a.createdAt),
    insertCode: async ({ email, codeHash, expiresAt }) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      codes.push({
        id,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(now),
      });
      return id;
    },
    deleteCode: async (id) =>
      void codes.splice(
        codes.findIndex((c) => c.id === id),
        1,
      ),
    latestActiveCode: async (email, at) =>
      codes
        .filter((c) => c.email === email && !c.consumedAt && c.expiresAt > at)
        .sort((a, b) => +b.createdAt - +a.createdAt)[0],
    addAttempt: async (id) => void (codes.find((c) => c.id === id)!.attempts += 1),
    consumeCodeAndSignIn: async ({ codeId, email, session, registeredEvent }) => {
      const code = codes.find((c) => c.id === codeId)!;
      if (code.consumedAt) return undefined;
      code.consumedAt = new Date(now);
      let user = users.find((u) => u.email === email);
      const isNewUser = !user;
      if (!user) {
        user = {
          id: `11111111-1111-4111-8111-${String(users.length + 1).padStart(12, '0')}`,
          email,
          createdAt: new Date(now),
        };
        users.push(user);
        events.push(registeredEvent(user.id, user.createdAt));
      }
      sessions.set(session.tokenHash, {
        userId: user.id,
        expiresAt: session.expiresAt,
        lastSeenAt: new Date(now),
      });
      return { user, isNewUser };
    },
    findUser: async (id) => users.find((u) => u.id === id),
    findSession: async (tokenHash, at) => {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > at ? { userId: s.userId, lastSeenAt: s.lastSeenAt } : undefined;
    },
    touchSession: async () => undefined,
    deleteSession: async (tokenHash) => void sessions.delete(tokenHash),
  };
  let now = Date.parse('2026-10-22T00:00:00Z');
  return { repo, events, advance: (ms: number) => (now += ms), now: () => new Date(now) };
}

function setup() {
  const memory = memoryRepo();
  const sent: { email: string; code: string }[] = [];
  const auth = createAuthService({
    repo: memory.repo,
    sender: { send: async (email, code) => void sent.push({ email, code }) },
    pepper: PEPPER,
    sessionTtlDays: 30,
    serviceName: 'identity',
    now: memory.now,
  });
  return { auth, sent, ...memory };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code: string }).code;
  }
  return 'no-error';
}

describe('验证码', () => {
  it('哈希绑定邮箱，换邮箱或换验证码都对不上', () => {
    const hash = hashCode(PEPPER, 'a@x.com', '123456');
    expect(codeMatches(hash, PEPPER, 'a@x.com', '123456')).toBe(true);
    expect(codeMatches(hash, PEPPER, 'b@x.com', '123456')).toBe(false);
    expect(codeMatches(hash, PEPPER, 'a@x.com', '654321')).toBe(false);
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('60 秒内不能重发，一小时最多 5 次', async () => {
    const { auth, advance } = setup();
    await auth.requestCode('a@x.com');
    expect(await errorCode(auth.requestCode('a@x.com'))).toBe('too_many_requests');
    for (let i = 0; i < AUTH_LIMITS.maxCodesPerHour - 1; i += 1) {
      advance(AUTH_LIMITS.resendCooldownMs);
      await auth.requestCode('a@x.com');
    }
    advance(AUTH_LIMITS.resendCooldownMs);
    expect(await errorCode(auth.requestCode('a@x.com'))).toBe('too_many_requests');
  });

  it('错 5 次后作废，必须重新获取', async () => {
    const { auth, sent } = setup();
    await auth.requestCode('a@x.com');
    const wrong = sent[0]!.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < AUTH_LIMITS.maxAttempts; i += 1) {
      expect(await errorCode(auth.verify('a@x.com', wrong))).toBe('invalid_code');
    }
    expect(await errorCode(auth.verify('a@x.com', sent[0]!.code))).toBe('too_many_attempts');
  });

  it('过期的验证码不能用', async () => {
    const { auth, sent, advance } = setup();
    await auth.requestCode('a@x.com');
    advance(AUTH_LIMITS.codeTtlMs + 1);
    expect(await errorCode(auth.verify('a@x.com', sent[0]!.code))).toBe('invalid_code');
  });
});

describe('登录与注册', () => {
  it('第一次登录注册新用户并发出注册事件；再次登录不重复发', async () => {
    const { auth, sent, events, advance } = setup();
    await auth.requestCode('A@x.com');
    const first = await auth.verify('a@x.com', sent[0]!.code);
    expect(first.isNewUser).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'identity.user.registered',
      data: { userId: first.user.id },
    });

    advance(AUTH_LIMITS.resendCooldownMs);
    await auth.requestCode('a@x.com');
    const second = await auth.verify('a@x.com', sent[1]!.code);
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(events).toHaveLength(1);
  });

  it('验证码只能用一次', async () => {
    const { auth, sent } = setup();
    await auth.requestCode('a@x.com');
    await auth.verify('a@x.com', sent[0]!.code);
    expect(await errorCode(auth.verify('a@x.com', sent[0]!.code))).toBe('invalid_code');
  });

  it('会话令牌能换出用户；退出后作废', async () => {
    const { auth, sent } = setup();
    await auth.requestCode('a@x.com');
    const { token, user } = await auth.verify('a@x.com', sent[0]!.code);
    expect(await auth.introspect(token)).toEqual({ userId: user.id });
    await auth.logout(token);
    expect(await errorCode(auth.introspect(token))).toBe('unauthenticated');
  });
});
