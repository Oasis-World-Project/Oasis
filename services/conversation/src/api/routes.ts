import { OASIS_HEADERS } from '@oasis/contracts/common';
import { CreateDmBody, SendMessageBody, type StreamEvent } from '@oasis/contracts/conversation';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { DmService } from '../service/dm-service.ts';

const IdParams = z.object({ id: z.uuid() });

export function registerRoutes(app: ServiceApp, dms: DmService): void {
  app.get('/v1/dms', async (request) => ({
    conversations: await dms.listDms(requireUserId(request)),
  }));

  app.post('/v1/dms', async (request) => {
    const { modelKey } = parseWith(CreateDmBody, request.body);
    return dms.createDm(requireUserId(request), modelKey, request.id);
  });

  app.get('/v1/conversations/:id/messages', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return { messages: await dms.listMessages(requireUserId(request), id) };
  });

  // 响应是 SSE 流：accepted → delta × N → done | error（见 contracts/conversation）
  app.post('/v1/conversations/:id/messages', async (request, reply) => {
    const ownerId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const { content } = parseWith(SendMessageBody, request.body);
    await dms.assertOwned(id, ownerId);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      [OASIS_HEADERS.requestId]: request.id,
    });
    // 用户中途关掉页面也照常把回复生成完并存库，下次打开能看到
    const emit = (event: StreamEvent) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await dms.sendMessage({ ownerId, conversationId: id, content, requestId: request.id, emit });
    } catch (err) {
      request.log.error({ err }, '发送消息失败');
      emit({ type: 'error', code: 'internal_error', message: '发送失败了，请重试' });
    }
    reply.raw.end();
  });
}
