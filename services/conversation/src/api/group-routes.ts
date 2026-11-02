import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  CreateGroupBody,
  GroupSendBody,
  InviteToken,
  RedeemGroupBody,
} from '@oasis/contracts/group';
import { HttpError, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { GroupService } from '../service/group-service.ts';

const Id = z.object({ id: z.uuid() });
const Cursor = z
  .object({
    after: z.coerce.number().int().nonnegative().safe().optional(),
    before: z.coerce.number().int().positive().safe().optional(),
  })
  .refine(
    (value) => value.after === undefined || value.before === undefined,
    '不能同时指定前后游标',
  );
export function registerGroupRoutes(app: ServiceApp, groups: GroupService, streamLimit: number) {
  const streams = new Map<string, Set<AbortController>>();
  app.addHook('preClose', async () => {
    for (const group of streams.values()) for (const controller of group) controller.abort();
  });
  app.get('/v1/groups', async (request) => ({ groups: await groups.list(requireUserId(request)) }));
  app.post('/v1/groups', async (request, reply) => {
    const body = parseWith(CreateGroupBody, request.body);
    return reply
      .code(201)
      .send(await groups.create(requireUserId(request), body.title, body.displayName));
  });
  app.post('/v1/groups/invites/preview', async (request) => {
    requireUserId(request);
    return groups.preview(parseWith(z.object({ token: InviteToken }), request.body).token);
  });
  app.post('/v1/groups/invites/redeem', async (request) => {
    const body = parseWith(RedeemGroupBody, request.body);
    return groups.redeem(requireUserId(request), body.token, body.displayName);
  });
  app.get('/v1/groups/:id', async (request) =>
    groups.get(
      requireUserId(request),
      parseWith(Id, request.params).id,
      parseWith(Cursor, request.query),
    ),
  );
  app.post('/v1/groups/:id/invites', async (request) =>
    groups.invite(requireUserId(request), parseWith(Id, request.params).id),
  );
  app.delete('/v1/groups/:id/invites', async (request, reply) => {
    await groups.revoke(requireUserId(request), parseWith(Id, request.params).id);
    return reply.code(204).send();
  });
  app.delete('/v1/groups/:id/members/:userId', async (request, reply) => {
    const params = parseWith(Id.extend({ userId: z.uuid() }), request.params);
    await groups.remove(requireUserId(request), params.id, params.userId);
    return reply.code(204).send();
  });
  app.delete('/v1/groups/:id', async (request, reply) => {
    await groups.destroy(requireUserId(request), parseWith(Id, request.params).id);
    return reply.code(204).send();
  });
  app.post('/v1/groups/:id/messages', async (request) => {
    const body = parseWith(GroupSendBody, request.body);
    return groups.send(
      requireUserId(request),
      parseWith(Id, request.params).id,
      body.content,
      body.requestId,
    );
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
        await delay(1000, undefined, { signal: controller.signal });
        snapshot = await groups.get(userId, id, { after });
      }
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404 && !reply.raw.destroyed)
        reply.raw.write('data: {"type":"removed"}\n\n');
      else if (!controller.signal.aborted) request.log.warn({ err: error }, '群消息连接中断');
    } finally {
      reply.raw.off('close', close);
      active.delete(controller);
      if (!active.size) streams.delete(userId);
      reply.raw.end();
    }
  });
}
