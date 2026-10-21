import { OASIS_HEADERS } from '@oasis/contracts/common';
import { ChatCompletionRequest } from '@oasis/contracts/model-gateway';
import { parseWith, requirePayerId, type ServiceApp } from '@oasis/service-kit';
import type { ChatService } from '../service/chat-service.ts';

export function registerRoutes(app: ServiceApp, chat: ChatService): void {
  // 只给内部服务用（gateway 不转发 /internal）。OpenAI 兼容；付费人放在 x-oasis-payer-id 头里。
  app.post('/internal/v1/chat/completions', async (request, reply) => {
    const payerId = requirePayerId(request);
    const body = parseWith(ChatCompletionRequest, request.body);
    const prepared = await chat.prepare({ payerId, requestId: request.id, body });

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const upstream = await chat.open(prepared, abort.signal);
    if (!body.stream) return chat.finishJson(prepared, upstream);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      [OASIS_HEADERS.requestId]: request.id,
    });
    await chat.pump(prepared, upstream, (chunk) => {
      if (!reply.raw.destroyed) reply.raw.write(chunk);
    });
    reply.raw.end();
  });
}
