import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  CreateDmBody,
  IntakeAnswersBody,
  SendMessageBody,
  StartIntakeBody,
  type IntakeResult,
  type StreamEvent,
} from '@oasis/contracts/conversation';
import { parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { Message } from '../repo/conversation-repo.ts';
import { toMessageBody, type DmService } from '../service/dm-service.ts';
import type { IntakeService } from '../service/intake-service.ts';

const IdParams = z.object({ id: z.uuid() });

const result = (messages: Message[]): IntakeResult => ({ messages: messages.map(toMessageBody) });

export function registerRoutes(app: ServiceApp, dms: DmService, intake: IntakeService): void {
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
    const { content, asTask, attachments: ids } = parseWith(SendMessageBody, request.body);
    await dms.assertOwned(id, ownerId);
    // 附件在开始推流之前核对，不对就直接报错（这时还能返回普通的错误响应）
    const attachments = await dms.resolveAttachments(ownerId, ids, request.id);

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
      await dms.sendMessage({
        ownerId,
        conversationId: id,
        content,
        asTask,
        attachments,
        requestId: request.id,
        emit,
      });
    } catch (err) {
      request.log.error({ err }, '发送消息失败');
      emit({ type: 'error', code: 'internal_error', message: '发送失败了，请重试' });
    }
    reply.raw.end();
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
    const { answers, skip } = parseWith(IntakeAnswersBody, request.body);
    const conversation = await dms.assertOwned(id, ownerId);
    return result(
      await intake.answer({ conversation, ownerId, answers, skip, requestId: request.id }),
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
    const conversation = await dms.assertOwned(id, ownerId);
    return result(await intake.confirm({ conversation, ownerId, requestId: request.id }));
  });
}
