// identity 的对外接口（经 gateway：/api/identity/v1/*）与内部接口（/internal/*）。
import { z } from 'zod';

export const RequestCodeBody = z.object({ email: z.email().max(254) });
export type RequestCodeBody = z.infer<typeof RequestCodeBody>;

export const VerifyCodeBody = z.object({
  email: z.email().max(254),
  code: z.string().regex(/^\d{6}$/, '验证码是 6 位数字'),
});
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

/** 账号 ID：系统发的 8 位数字，不能改；别人按它加好友 */
export const AccountNo = z.string().regex(/^[1-9]\d{7}$/, '账号 ID 是 8 位数字');
export const Gender = z.enum(['', 'male', 'female', 'other']);
export type Gender = z.infer<typeof Gender>;

/** 别人能看到的资料 */
export const PublicProfile = z.object({
  id: z.uuid(),
  accountNo: AccountNo,
  name: z.string(),
  /** 签名，没写为空 */
  bio: z.string(),
  gender: Gender,
  region: z.string(),
  /** 头像换过几次；0 是没传过头像（界面用名字的第一个字）。头像地址带上它，换了就是新地址 */
  avatarVersion: z.number().int().nonnegative(),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

export const MeBody = PublicProfile.extend({
  email: z.email(),
  createdAt: z.iso.datetime(),
});
export type MeBody = z.infer<typeof MeBody>;

/** 改资料：四项一起交 */
export const UpdateProfileBody = z.object({
  name: z.string().trim().min(1, '名字不能空着').max(20),
  bio: z.string().trim().max(60),
  gender: Gender,
  region: z.string().trim().max(30),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

/** 头像：前端裁成方的小图再传，最多 200 KB */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_MAX_BYTES = 200_000;
export const AvatarBody = z.object({
  type: z.enum(AVATAR_TYPES),
  /** 图片内容，base64 */
  data: z.string().min(1).max(280_000),
});

/** 按用户 ID 批量取资料（好友列表、群成员的头像和名字） */
export const ProfilesBody = z.object({ ids: z.array(z.uuid()).max(200) });
export const ProfileList = z.object({ profiles: z.array(PublicProfile) });
export type ProfileList = z.infer<typeof ProfileList>;

export const VerifyCodeResult = z.object({ user: MeBody, isNewUser: z.boolean() });
export type VerifyCodeResult = z.infer<typeof VerifyCodeResult>;

/** 内部：gateway 拿会话令牌换用户 ID。 */
export const IntrospectBody = z.object({ token: z.string().min(1).max(200) });
export const IntrospectResult = z.object({ userId: z.uuid() });
export type IntrospectResult = z.infer<typeof IntrospectResult>;

/** 会话 Cookie 的名字：identity 写入，gateway 读取。 */
export const SESSION_COOKIE = 'oasis_session';
