// 群的接口：建群、成员（群主拉好友）、群里的 AI、发消息、推送。非成员读取或操作一律 404。
// 两个好友的私聊读消息、发消息、推送也用这里的接口（GET、messages、events）。
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AddGroupAiBody,
  AddGroupMemberBody,
  AssignEditBody,
  CreateGroupBody,
  GroupAiRoleBody,
  GroupNicknameBody,
  GroupOptionsPatch,
  GroupSendBody,
  GroupSteerBody,
  inFlux,
} from '@oasis/contracts/group';
import { HttpError, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { GroupService } from '../service/group-service.ts';

const Id = z.object({ id: z.uuid() });
const AiParams = Id.extend({ key: z.string().min(1).max(50) });
const MessageParams = Id.extend({ messageId: z.uuid() });
const Cursor = z
  .object({
    after: z.coerce.number().int().nonnegative().safe().optional(),
    before: z.coerce.number().int().positive().safe().optional(),
  })
  .refine(
    (value) => value.after === undefined || value.before === undefined,
    '不能同时指定前后游标',
  );
export function registerGroupRoutes(
  app: ServiceApp,
  groups: GroupService,
  streamLimit: number,
  /** 每个群现在有几条推送连着：有人开着群，「积极参与」的 AI 才会自己起话头 */
  watching = new Map<string, number>(),
) {
  const streams = new Map<string, Set<AbortController>>();
  app.addHook('preClose', async () => {
    for (const group of streams.values()) for (const controller of group) controller.abort();
  });
  app.get('/v1/groups', async (request) => ({ groups: await groups.list(requireUserId(request)) }));
  app.post('/v1/groups', async (request, reply) => {
    const body = parseWith(CreateGroupBody, request.body);
    return reply.code(201).send(await groups.create(requireUserId(request), body, request.id));
  });
  app.get('/v1/groups/:id', async (request) =>
    groups.get(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(Cursor, request.query),
    ),
  );
  /** 群主改群的设置：光色、发言方式、分工方式 */
  app.put('/v1/groups/:id/options', async (request) =>
    groups.setOptions(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(GroupOptionsPatch, request.body),
    ),
  );
  /** 群主叫一个 AI 进群 */
  app.post('/v1/groups/:id/ais', async (request) =>
    groups.addAi(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(AddGroupAiBody, request.body).key,
      request.id,
    ),
  );
  /** 群主写这个 AI 在群里负责什么 */
  app.put('/v1/groups/:id/ais/:key', async (request) => {
    const { id, key } = parseWith(AiParams, request.params);
    const { role } = parseWith(GroupAiRoleBody, request.body);
    return groups.setRole(requireUserId(request), id, key, role);
  });
  /** 群主把一个 AI 移出群 */
  app.delete('/v1/groups/:id/ais/:key', async (request, reply) => {
    const { id, key } = parseWith(AiParams, request.params);
    await groups.removeAi(requireUserId(request), id, key, request.id);
    return reply.code(204).send();
  });
  /** 停下这个 AI 正在做的一轮 */
  app.post('/v1/groups/:id/ais/:key/stop', async (request, reply) => {
    const { id, key } = parseWith(AiParams, request.params);
    await groups.stopAi(requireUserId(request), id, key);
    return reply.code(204).send();
  });
  /** 人改分工单：改派、改要求、撤掉一项，或整份全部停下 */
  app.post('/v1/groups/:id/assigns/:messageId', async (request, reply) => {
    const { id, messageId } = parseWith(MessageParams, request.params);
    await groups.editAssign(
      requireUserId(request),
      id,
      messageId,
      parseWith(AssignEditBody, request.body),
    );
    return reply.code(204).send();
  });
  /** 群主把一个好友直接拉进群（不用对方同意） */
  app.post('/v1/groups/:id/members', async (request) =>
    groups.addMember(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(AddGroupMemberBody, request.body).userId,
      request.id,
    ),
  );
  /** 改自己在这个群里的昵称 */
  app.put('/v1/groups/:id/nickname', async (request) =>
    groups.setNickname(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(GroupNicknameBody, request.body).nickname,
    ),
  );
  app.delete('/v1/groups/:id/members/:userId', async (request, reply) => {
    const params = parseWith(Id.extend({ userId: z.uuid() }), request.params);
    await groups.remove(requireUserId(request), params.id, params.userId);
    return reply.code(204).send();
  });
  app.delete('/v1/groups/:id', async (request, reply) => {
    await groups.destroy(requireUserId(request), parseWith(Id, request.params).id, request.id);
    return reply.code(204).send();
  });
  app.post('/v1/groups/:id/messages', async (request) => {
    const body = parseWith(GroupSendBody, request.body);
    return groups.send(
      requireUserId(request),
      parseWith(Id, request.params).id,
      body.content,
      body.requestId,
      body.mentions,
      body,
    );
  });
  /** 「现在告诉它」：@ 了这个 AI、它还没看到的一句，现在作为插话送进它正在做的一轮 */
  app.post('/v1/groups/:id/messages/:messageId/steer', async (request, reply) => {
    const { id, messageId } = parseWith(MessageParams, request.params);
    const { key } = parseWith(GroupSteerBody, request.body);
    await groups.steer(requireUserId(request), id, messageId, key);
    return reply.code(204).send();
  });
  app.get('/v1/groups/:id/events', async (request, reply) => {
    const userId = requireUserId(request),
      id = parseWith(Id, request.params).id;
    const raw = request.headers['last-event-id'];
    let after = parseWith(Cursor, request.query).after;
    if (typeof raw === 'string')
      after = parseWith(z.coerce.number().int().nonnegative().safe(), raw);
    // 务必在开始 SSE 前鉴权；之后每次读取都重新核对成员资格。
    let snapshot = await groups.get(userId, id, { after });
    const active = streams.get(userId) ?? new Set<AbortController>();
    if (active.size >= streamLimit)
      throw new HttpError(429, 'group_stream_limit', '打开的群连接太多，请关闭一些页面');
    const controller = new AbortController();
    active.add(controller);
    streams.set(userId, active);
    watching.set(id, (watching.get(id) ?? 0) + 1);
    const close = () => controller.abort();
    reply.raw.once('close', close);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const until = Date.now() + 60000; // 定期重连，让 gateway 重新验证登录会话。
    try {
      while (!controller.signal.aborted && Date.now() < until) {
        if (reply.raw.writableLength > 256 * 1024) break;
        if (snapshot.messages.length) after = snapshot.messages.at(-1)!.seq;
        after ??= 0;
        reply.raw.write(
          `id: ${after}\ndata: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\n`,
        );
        // AI 的消息是原地更新的（序号不变）：还在变的下次连同最新的样子再给一遍，直到它不再变
        const watch = snapshot.live.filter(inFlux).map((message) => message.id);
        await delay(1000, undefined, { signal: controller.signal });
        snapshot = await groups.get(userId, id, { after }, watch);
      }
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404 && !reply.raw.destroyed)
        reply.raw.write('data: {"type":"removed"}\n\n');
      else if (!controller.signal.aborted) request.log.warn({ err: error }, '群消息连接中断');
    } finally {
      reply.raw.off('close', close);
      active.delete(controller);
      if (!active.size) streams.delete(userId);
      const left = (watching.get(id) ?? 1) - 1;
      if (left > 0) watching.set(id, left);
      else watching.delete(id);
      reply.raw.end();
    }
  });
}
