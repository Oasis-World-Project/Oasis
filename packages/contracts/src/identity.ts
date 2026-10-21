// identity 的对外接口（经 gateway：/api/identity/v1/*）与内部接口（/internal/*）。
import { z } from 'zod';

export const RequestCodeBody = z.object({ email: z.email().max(254) });
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

export const VerifyCodeBody = z.object({
  email: z.email().max(254),
  code: z.string().regex(/^\d{6}$/, '验证码是 6 位数字'),
});
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

export const MeBody = z.object({
  id: z.uuid(),
  email: z.email(),
  createdAt: z.iso.datetime(),
});
export type MeBody = z.infer<typeof MeBody>;

export const VerifyCodeResult = z.object({ user: MeBody, isNewUser: z.boolean() });
export type VerifyCodeResult = z.infer<typeof VerifyCodeResult>;

/** 内部：gateway 拿会话令牌换用户 ID。 */
export const IntrospectBody = z.object({ token: z.string().min(1).max(200) });
export const IntrospectResult = z.object({ userId: z.uuid() });
export type IntrospectResult = z.infer<typeof IntrospectResult>;

/** 会话 Cookie 的名字：identity 写入，gateway 读取。 */
export const SESSION_COOKIE = 'oasis_session';
