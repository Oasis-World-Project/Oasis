// 私聊的接口（群聊见 group-routes.ts）。发消息立即返回：AI 这一轮在后台做，前端刷新消息看进度。
import { Readable } from 'node:stream';
import {
  ConfirmBody,
  CreateDmBody,
  SendMessageBody,
  SetupBody,
} from '@oasis/contracts/conversation';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { DmService } from '../service/dm-service.ts';

const IdParams = z.object({ id: z.uuid() });
const ConfirmationParams = z.object({ id: z.uuid(), confirmationId: z.uuid() });
const RunFileParams = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  '*': z.string().min(1).max(1000),
});

export function registerRoutes(app: ServiceApp, dms: DmService): void {
  app.get('/v1/dms', async (request) => ({
    conversations: await dms.listDms(requireUserId(request)),
  }));

  app.post('/v1/dms', async (request) => {
    const { modelKey } = parseWith(CreateDmBody, request.body);
    return dms.createDm(requireUserId(request), modelKey, request.id);
  });

  /** 删除私聊（真删除）：正在进行的一轮先取消，消息、成品、AI 的会话记录和工作目录都删掉 */
  app.delete('/v1/conversations/:id', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    await dms.deleteDm(requireUserId(request), id, request.id);
    return reply.code(204).send();
  });

  /** 消息和正在进行的一轮（有一轮在进行时前端定时刷新） */
  app.get('/v1/conversations/:id/messages', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return dms.listMessages(requireUserId(request), id);
  });

  /** 发一条消息：开一轮，或插话进正在进行的这一轮；可以带文件、带要改的画布成果 */
  app.post('/v1/conversations/:id/messages', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const body = parseWith(SendMessageBody, request.body);
    return reply.code(201).send(
      await dms.sendMessage({
        ownerId: requireUserId(request),
        conversationId: id,
        ...body,
        requestId: request.id,
      }),
    );
  });

  /** 某一轮工作目录里的一个文件：进度页预览这一轮做出的中间产物和成品 */
  app.get('/v1/conversations/:id/runs/:runId/files/*', async (request, reply) => {
    const { id, runId, '*': path } = parseWith(RunFileParams, request.params);
    const file = await dms.runFile(requireUserId(request), id, runId, path);
    reply.header('content-type', file.contentType).header('cache-control', 'no-store');
    if (file.size) reply.header('content-length', file.size);
    return reply.send(file.body ? Readable.fromWeb(file.body) : '');
  });

  /** 停下正在进行的一轮 */
  app.post('/v1/conversations/:id/stop', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    await dms.stop(requireUserId(request), id);
    return reply.code(204).send();
  });

  /** 改在哪干活和权限：换了地方从新话题开始，回改好的私聊和分隔消息 */
  app.put('/v1/conversations/:id/setup', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    const body = parseWith(SetupBody, request.body);
    return dms.setup(requireUserId(request), id, body, request.id);
  });

  /** 点确认卡：允许一次 / 以后都允许 / 拒绝 */
  app.post('/v1/conversations/:id/confirmations/:confirmationId', async (request) => {
    const { id, confirmationId } = parseWith(ConfirmationParams, request.params);
    const { decision } = parseWith(ConfirmBody, request.body);
    return dms.confirm({
      ownerId: requireUserId(request),
      conversationId: id,
      confirmationId,
      decision,
      requestId: request.id,
    });
  });

  /** 开新话题：AI 从这里起不记得之前的事 */
  app.post('/v1/conversations/:id/topics', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const message = await dms.newTopic(requireUserId(request), id, request.id);
    return reply.code(201).send({ message });
  });
}
