import { describe, expect, it } from 'vitest';
import { AUTH_LIMITS, createAuthService } from '../src/service/auth-service.ts';
import { codeMatches, hashCode, normalizeEmail } from '../src/service/codes.ts';
import { memoryRepo } from './memory-repo.ts';

const PEPPER = 'test-pepper-0123456789';

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
