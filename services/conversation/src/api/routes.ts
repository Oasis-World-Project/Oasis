import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  CreateDmBody,
  IntakeAnswersBody,
  IntakeConfirmBody,
  ReplaceReplyBody,
  SendMessageBody,
  StartIntakeBody,
  type IntakeResult,
  type StreamEvent,
} from '@oasis/contracts/conversation';
import { HttpError, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Message } from '../repo/conversation-repo.ts';
import { toMessageBody, type DmService } from '../service/dm-service.ts';
import type { IntakeService } from '../service/intake-service.ts';

const IdParams = z.object({ id: z.uuid() });
const MessageParams = IdParams.extend({ messageId: z.uuid() });

async function eventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (emit: (event: StreamEvent) => void) => Promise<void>,
) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    [OASIS_HEADERS.requestId]: request.id,
  });
  const emit = (event: StreamEvent) => {
    if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await work(emit);
  } catch (err) {
    if (!(err instanceof HttpError) || err.statusCode >= 500)
      request.log.error({ err }, '消息操作失败');
    emit({
      type: 'error',
      code: err instanceof HttpError ? err.code : 'internal_error',
      message:
        err instanceof HttpError && err.statusCode < 500 ? err.message : '操作失败了，请重试',
    });
  } finally {
    reply.raw.end();
  }
}

const result = (messages: Message[]): IntakeResult => ({ messages: messages.map(toMessageBody) });

export function registerRoutes(app: ServiceApp, dms: DmService, intake: IntakeService): void {
  app.get('/v1/dms', async (request) => ({
    conversations: await dms.listDms(requireUserId(request)),
  }));

  app.post('/v1/dms', async (request) => {
    const { modelKey } = parseWith(CreateDmBody, request.body);
    return dms.createDm(requireUserId(request), modelKey, request.id);
  });

  /**
   * 删除私聊（2026-11-05）：这段私聊的消息、卡片、附件和摘要真删除；任务和成果不受影响，
   * 再点开这个 AI 是一个全新的空白私聊。
   */
  app.delete('/v1/conversations/:id', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    await dms.deleteDm(requireUserId(request), id, request.id);
    return reply.code(204).send();
  });

  app.get('/v1/conversations/:id/messages', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return { messages: await dms.listMessages(requireUserId(request), id) };
  });

  // 响应是 SSE 流：accepted → delta × N → done | error（见 contracts/conversation）
  app.post('/v1/conversations/:id/messages', async (request, reply) => {
    const ownerId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const { content, asTask, attachments: ids } = parseWith(SendMessageBody, request.body);
    await dms.assertOwned(id, ownerId);
    // 附件在开始推流之前核对，不对就直接报错（这时还能返回普通的错误响应）
    const attachments = await dms.resolveAttachments(ownerId, ids, request.id);

    // 页面关闭仍保存回复；用户显式停止走独立 stop 接口，不触碰任务运行。
    await eventStream(request, reply, (emit) =>
      dms.sendMessage({
        ownerId,
        conversationId: id,
        content,
        asTask,
        attachments,
        requestId: request.id,
        emit,
      }),
    );
  });

  app.delete('/v1/conversations/:id/messages/:messageId', async (request, reply) => {
    const { id, messageId } = parseWith(MessageParams, request.params);
    await dms.deleteMessage(requireUserId(request), id, messageId);
    return reply.code(204).send();
  });
  app.post('/v1/conversations/:id/messages/:messageId/stop', async (request, reply) => {
    const { id, messageId } = parseWith(MessageParams, request.params);
    await dms.stopReply(requireUserId(request), id, messageId);
    return reply.code(204).send();
  });
  app.post('/v1/conversations/:id/messages/:messageId/reply', async (request, reply) => {
    const { id, messageId } = parseWith(MessageParams, request.params);
    const ownerId = requireUserId(request);
    const { content, continue: continuing } = parseWith(ReplaceReplyBody, request.body);
    await dms.assertOwned(id, ownerId);
    await eventStream(request, reply, (emit) =>
      dms.replaceReply({
        ownerId,
        conversationId: id,
        messageId,
        ...(continuing ? { continue: true } : {}),
        ...(content === undefined ? {} : { content }),
        requestId: request.id,
        emit,
      }),
    );
  });

  // ---- 在私聊里接任务（ADR 0005）：都返回这次新增的消息 ----
  /** 点了「当成任务来做」：从某条用户消息开始接需求 */
  app.post('/v1/conversations/:id/intake/start', async (request) => {
    const ownerId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const { messageId } = parseWith(StartIntakeBody, request.body);
    const conversation = await dms.assertOwned(id, ownerId);
    return result(
      await intake.startFrom({ conversation, ownerId, messageId, requestId: request.id }),
    );
  });

  /** 回答问题卡（可以只答一部分）；skip = 直接开始 */
  app.post('/v1/conversations/:id/intake/answers', async (request) => {
    const ownerId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const { answers, skip, messageId } = parseWith(IntakeAnswersBody, request.body);
    const conversation = await dms.assertOwned(id, ownerId);
    return result(
      await intake.answer({
        conversation,
        ownerId,
        answers,
        skip,
        messageId,
        requestId: request.id,
      }),
    );
  });

  /** 不是任务 / 不做了 */
  app.post('/v1/conversations/:id/intake/cancel', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return result(await intake.cancel(await dms.assertOwned(id, requireUserId(request))));
  });

  /** 确认任务单：交给 AI 团队 */
  app.post('/v1/conversations/:id/intake/confirm', async (request) => {
    const ownerId = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    const budget = parseWith(IntakeConfirmBody, request.body ?? {});
    const conversation = await dms.assertOwned(id, ownerId);
    return result(await intake.confirm({ conversation, ownerId, budget, requestId: request.id }));
  });
}
