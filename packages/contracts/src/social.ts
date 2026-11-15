// 好友：按账号 ID 找到人、发申请，对方同意后成为好友。好友之间可以私聊（普通聊天），群主可以把好友直接拉进群。
// 资料（名字、头像……）在 identity，这里的接口把对方的资料一起带回来。
import { z } from 'zod';
import { PublicProfile } from './identity.ts';

/** 申请加好友：对方的用户 ID（先按账号 ID 查到人），和一句验证消息 */
export const FriendRequestBody = z.object({
  userId: z.uuid(),
  message: z.string().trim().max(60).default(''),
});
/** 发出申请后：等对方同意，或者对方也申请过我、直接成了好友 */
export const FriendRequestResult = z.object({ status: z.enum(['requested', 'friends']) });
export type FriendRequestResult = z.infer<typeof FriendRequestResult>;

export const Friend = z.object({
  profile: PublicProfile,
  since: z.iso.datetime(),
  /** 和他的私聊；还没聊过为 null */
  chatId: z.uuid().nullable(),
});
export type Friend = z.infer<typeof Friend>;
/** 一条好友申请：profile 是对方（发给我的是申请人，我发出去的是收的人） */
export const FriendRequest = z.object({
  id: z.uuid(),
  profile: PublicProfile,
  message: z.string(),
  createdAt: z.iso.datetime(),
});
export type FriendRequest = z.infer<typeof FriendRequest>;
export const FriendsBody = z.object({
  friends: z.array(Friend),
  /** 别人发给我、还没回的 */
  incoming: z.array(FriendRequest),
  /** 我发出去、对方还没回的 */
  outgoing: z.array(FriendRequest),
});
export type FriendsBody = z.infer<typeof FriendsBody>;
/** 打开和一个好友的私聊：它的 ID（读消息、发消息、推送走群的那一套接口） */
export const FriendChat = z.object({ id: z.uuid() });
