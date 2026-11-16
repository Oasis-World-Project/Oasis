// 好友的接口：列表和申请、同意、拒绝或撤回、删好友、打开和好友的私聊。
import { FriendRequestBody } from '@oasis/contracts/social';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { FriendService } from '../service/friend-service.ts';

const Id = z.object({ id: z.uuid() });
const UserId = z.object({ userId: z.uuid() });

export function registerFriendRoutes(app: ServiceApp, friends: FriendService): void {
  app.get('/v1/friends', async (request) => friends.list(requireUserId(request), request.id));
  app.post('/v1/friends/requests', async (request) => {
    const body = parseWith(FriendRequestBody, request.body);
    return friends.request(requireUserId(request), body.userId, body.message, request.id);
  });
  app.post('/v1/friends/requests/:id/accept', async (request, reply) => {
    await friends.accept(requireUserId(request), parseWith(Id, request.params).id);
    return reply.code(204).send();
  });
  app.delete('/v1/friends/requests/:id', async (request, reply) => {
    await friends.dropRequest(requireUserId(request), parseWith(Id, request.params).id);
    return reply.code(204).send();
  });
  app.delete('/v1/friends/:userId', async (request, reply) => {
    const { userId } = parseWith(UserId, request.params);
    await friends.unfriend(requireUserId(request), userId, request.id);
    return reply.code(204).send();
  });
  app.post('/v1/friends/:userId/chat', async (request) =>
    friends.openChat(requireUserId(request), parseWith(UserId, request.params).userId, request.id),
  );
}
