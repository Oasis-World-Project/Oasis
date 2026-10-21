// 验证码与会话令牌的生成和校验（纯函数，便于单测）。
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** 验证码哈希绑定邮箱，同一个验证码换个邮箱也对不上。 */
export function hashCode(pepper: string, email: string, code: string): string {
  return createHmac('sha256', pepper).update(`${email}:${code}`).digest('hex');
}

export function codeMatches(
  expectedHash: string,
  pepper: string,
  email: string,
  code: string,
): boolean {
  const actual = Buffer.from(hashCode(pepper, email, code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
