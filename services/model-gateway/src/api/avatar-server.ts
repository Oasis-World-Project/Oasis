// 给 LiveAvatar 回调用的大模型入口（ADR 0013 §6）：单独端口，只有一条路径，经隧道和反向代理暴露到公网。
// 不和主端口放在一起：主端口上的 /internal/* 只认请求头里的付费人，不能让服务器上的其他进程碰到。
// 每一轮：认会话 Key → 换上我们的系统提示（人设、口语规则、检索到的知识要点、转人工）→ 关掉思考 →
// 流式转发 → 记下这一轮（问题、回答、引用、是否转人工、首字时间）。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { ChatCompletionRequest } from '@oasis/contracts/model-gateway';
import { createHttpServer, HttpError, parseWith, type Logger } from '@oasis/service-kit';
import type { FastifyReply } from 'fastify';
import type { AvatarService } from '../service/avatar-service.ts';
import { createAnswerSniffer, planTurn, saidHandoff } from '../service/avatar-turns.ts';
import type { ChatService } from '../service/chat-service.ts';
import type { RunKeyService } from '../service/run-key-service.ts';

export const AVATAR_COMPLETIONS_PATH = '/avatar/v1/chat/completions';
/** 口语回答很短；给够余量但别让一轮说太久 */
const MAX_ANSWER_TOKENS = 400;

function abortOnClose(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}

export function createAvatarLlmServer(deps: {
  logger: Logger;
  runKeys: RunKeyService;
  chat: ChatService;
  avatars: AvatarService;
  model: string;
  clock?: () => number;
}) {
  const clock = deps.clock ?? Date.now;
  const app = createHttpServer({
    service: 'model-gateway-avatar',
    version: 'avatar-llm',
    commit: process.env.GIT_COMMIT ?? 'dev',
    logger: deps.logger,
    resources: [],
    isShuttingDown: () => false,
  });

  app.post(AVATAR_COMPLETIONS_PATH, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const startedAt = clock();
    const caller = await deps.runKeys.authenticate(request.headers.authorization);
    // 只放行正在进行的数字人会话的 Key（沙箱里 agent 的 Key 不能从这里用）
    const session = await deps.avatars.liveSession(caller.runId);
    if (!session) throw new HttpError(401, 'invalid_run_key', '运行凭证无效或已过期');

    const incoming = parseWith(ChatCompletionRequest, request.body);
    const turn = planTurn(session.spec, incoming.messages);
    const { max_completion_tokens: _ignored, ...rest } = incoming;
    const body: ChatCompletionRequest = {
      ...rest,
      model: deps.model,
      messages: turn.messages,
      max_tokens: MAX_ANSWER_TOKENS,
      // 数字人要马上开口：不让模型先「思考」（OpenRouter 的统一参数）
      reasoning: { enabled: false },
    };

    const record = (answer: string, firstAt: number | undefined) =>
      deps.avatars
        .recordTurn(session.id, {
          at: new Date(startedAt).toISOString(),
          question: turn.question,
          answer,
          sources: turn.sources,
          handoff: saidHandoff(session.spec, answer),
          firstTokenMs: firstAt === undefined ? null : Math.max(0, firstAt - startedAt),
          totalMs: Math.max(0, clock() - startedAt),
        })
        .catch((err: unknown) => request.log.warn({ err }, '记录数字人这一轮失败'));

    const prepared = await deps.chat.prepare({ caller, requestId: request.id, body });
    const upstream = await deps.chat.open(prepared, abortOnClose(reply));
    if (!body.stream) {
      const json = (await deps.chat.finishJson(prepared, upstream)) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      await record(typeof content === 'string' ? content : '', clock());
      return json;
    }

    const sniffer = createAnswerSniffer(clock);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      [OASIS_HEADERS.requestId]: request.id,
    });
    await deps.chat.pump(prepared, upstream, (chunk) => {
      sniffer.push(chunk);
      if (!reply.raw.destroyed) reply.raw.write(chunk);
    });
    reply.raw.end();
    await record(sniffer.answer(), sniffer.firstAt());
  });
  return app;
}
