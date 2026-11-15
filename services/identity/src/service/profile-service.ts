// 账号资料：自己改名字、签名、性别、地区、头像；按账号 ID 查人；按用户 ID 批量取资料。
// 资料是公开给登录用户看的（和按 ID 加好友一个道理），邮箱不在里面。
import {
  AVATAR_MAX_BYTES,
  type AVATAR_TYPES,
  type MeBody,
  type PublicProfile,
  type UpdateProfileBody,
} from '@oasis/contracts/identity';
import { HttpError } from '@oasis/service-kit';
import type { IdentityRepo } from '../repo/identity-repo.ts';
import { toMe, toProfile } from './auth-service.ts';

/** 按账号 ID 查人：每人每分钟最多这么多次（防止挨个试号） */
const LOOKUPS_PER_MINUTE = 20;

type AvatarType = (typeof AVATAR_TYPES)[number];
/** 图片开头的几个字节：只收真的是这几种图片的内容 */
const SIGNATURES: Record<AvatarType, (bytes: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

export function createProfileService(deps: { repo: IdentityRepo; now?: () => number }) {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
  /** 每个人最近一分钟查过的时刻（单实例内存里记；多实例部署时要挪到共享存储） */
  const lookups = new Map<string, number[]>();

  return {
    async update(userId: string, body: UpdateProfileBody): Promise<MeBody> {
      const user = await repo.updateProfile(userId, body);
      if (!user) throw new HttpError(401, 'unauthenticated', '账号不存在');
      return toMe(user);
    },

    async setAvatar(userId: string, type: AvatarType, data: string): Promise<MeBody> {
      const content = Buffer.from(data, 'base64');
      if (!content.length || content.length > AVATAR_MAX_BYTES)
        throw new HttpError(413, 'avatar_too_large', '头像最多 200 KB');
      if (!SIGNATURES[type](content))
        throw new HttpError(400, 'avatar_invalid', '头像要是 PNG、JPEG 或 WebP 图片');
      const user = await repo.setAvatar(userId, { content, type });
      if (!user) throw new HttpError(401, 'unauthenticated', '账号不存在');
      return toMe(user);
    },

    async clearAvatar(userId: string): Promise<MeBody> {
      const user = await repo.setAvatar(userId, null);
      if (!user) throw new HttpError(401, 'unauthenticated', '账号不存在');
      return toMe(user);
    },

    async avatar(userId: string) {
      const avatar = await repo.avatar(userId);
      if (!avatar) throw new HttpError(404, 'avatar_not_found', '没有头像');
      return avatar;
    },

    /** 按账号 ID 查人（加好友前先看到是谁） */
    async lookup(userId: string, accountNo: string): Promise<PublicProfile> {
      const since = now() - 60_000;
      const recent = (lookups.get(userId) ?? []).filter((at) => at > since);
      if (recent.length >= LOOKUPS_PER_MINUTE)
        throw new HttpError(429, 'lookup_rate_limited', '查得太勤了，过一会儿再试');
      lookups.set(userId, [...recent, now()]);
      const user = await repo.findByAccountNo(accountNo);
      if (!user) throw new HttpError(404, 'user_not_found', '没有这个账号 ID');
      return toProfile(user);
    },

    async profiles(ids: string[]): Promise<PublicProfile[]> {
      return (await repo.findUsers([...new Set(ids)])).map(toProfile);
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
