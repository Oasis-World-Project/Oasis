// 好友：申请（带一句验证消息）、同意、拒绝或撤回、删好友；两个好友之间的私聊。
// 资料从 identity 取（profiles.ts），列表里把对方的资料一起带回去。
import type { Friend, FriendRequest, FriendsBody } from '@oasis/contracts/social';
import type { FriendRepo } from '../repo/friend-repo.ts';
import type { Profiles } from './profiles.ts';

export function createFriendService(deps: { repo: FriendRepo; profiles: Profiles }) {
  const { repo, profiles } = deps;
  return {
    /** 我的好友、别人发给我的申请、我发出去还没回的申请 */
    async list(userId: string, requestId: string): Promise<FriendsBody> {
      const [friends, requests] = await Promise.all([repo.friends(userId), repo.requests(userId)]);
      const people = await profiles.get(
        [
          ...friends.map((row) => row.friend_id),
          ...requests.map((row) => (row.to_id === userId ? row.from_id : row.to_id)),
        ],
        requestId,
      );
      const request = (row: (typeof requests)[number], other: string): FriendRequest[] => {
        const profile = people.get(other);
        return profile
          ? [{ id: row.id, profile, message: row.message, createdAt: row.created_at.toISOString() }]
          : [];
      };
      return {
        friends: friends.flatMap((row): Friend[] => {
          const profile = people.get(row.friend_id);
          return profile
            ? [{ profile, since: row.created_at.toISOString(), chatId: row.chat_id }]
            : [];
        }),
        incoming: requests.flatMap((row) =>
          row.to_id === userId ? request(row, row.from_id) : [],
        ),
        outgoing: requests.flatMap((row) =>
          row.from_id === userId ? request(row, row.to_id) : [],
        ),
      };
    },
    /** 申请加好友：对方得是真的账号 */
    async request(userId: string, target: string, message: string, requestId: string) {
      await profiles.one(target, requestId);
      return { status: await repo.request(userId, target, message) };
    },
    accept: repo.accept,
    dropRequest: repo.dropRequest,
    unfriend: repo.unfriend,
    /** 打开和一个好友的私聊（没有就建），返回它的 ID */
    async openChat(userId: string, friendId: string, requestId: string) {
      const people = await profiles.get([userId, friendId], requestId);
      const mine = people.get(userId)?.name,
        theirs = people.get(friendId)?.name;
      return {
        id: await repo.openChat(userId, friendId, { mine: mine ?? '我', theirs: theirs ?? '好友' }),
      };
    },
  };
}
export type FriendService = ReturnType<typeof createFriendService>;
