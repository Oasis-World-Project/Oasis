import { OASIS_HEADERS } from '@oasis/contracts/common';
import {
  ChatCompletionRequest,
  CreateRunKeyBody,
  DecisionRequest,
} from '@oasis/contracts/model-gateway';
import { parseWith, requirePayerId, type ServiceApp } from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatService } from '../service/chat-service.ts';
import type { DecisionService } from '../service/decision-service.ts';
import type { Caller } from '../service/metering.ts';
import type { RunKeyService } from '../service/run-key-service.ts';

const KeyIdParams = z.object({ keyId: z.uuid() });
const Attribution = z.object({
  [OASIS_HEADERS.taskId]: z.uuid().optional(),
  [OASIS_HEADERS.nodeId]: z.uuid().optional(),
});

/** 内部调用方：付费人必填，任务和节点可选 */
function internalCaller(request: FastifyRequest): Caller {
  const headers = parseWith(Attribution, request.headers);
  const taskId = headers[OASIS_HEADERS.taskId];
  const nodeId = headers[OASIS_HEADERS.nodeId];
  return {
    payerId: requirePayerId(request),
    ...(taskId ? { taskId } : {}),
    ...(taskId && nodeId ? { nodeId } : {}),
  };
}

/** 客户端断开时取消上游请求（已产生的部分照样按实际花费结算）。 */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}

export function registerRoutes(
  app: ServiceApp,
  services: { chat: ChatService; decisions: DecisionService; runKeys: RunKeyService },
): void {
  const { chat, decisions, runKeys } = services;

  /** OpenAI 兼容的 chat completions：流式时原样转发 SSE。 */
  async function completions(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const body = parseWith(ChatCompletionRequest, request.body);
    const prepared = await chat.prepare({ caller, requestId: request.id, body });
    const upstream = await chat.open(prepared, abortOnClose(reply));
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
  }

  async function decide(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const body = parseWith(DecisionRequest, request.body);
    return decisions.decide({ caller, requestId: request.id, body, signal: abortOnClose(reply) });
  }

  // ---- 内部服务用（gateway 不转发 /internal）：付费人放在 x-oasis-payer-id 头里；
  // 替任务调用时（如 task 的关卡）再带上 x-oasis-task-id / x-oasis-node-id，花费计入任务 ----
  app.post('/internal/v1/chat/completions', (request, reply) =>
    completions(internalCaller(request), request, reply),
  );
  app.post('/internal/v1/decisions', (request, reply) =>
    decide(internalCaller(request), request, reply),
  );

  /** harness 为一次 agent 运行签发临时 Key；明文只在这里返回一次。 */
  app.post('/internal/run-keys', async (request, reply) => {
    const body = parseWith(CreateRunKeyBody, request.body);
    return reply.code(201).send(await runKeys.issue(body));
  });
  /** 运行结束或取消时作废（幂等）。 */
  app.post('/internal/run-keys/:keyId/revoke', async (request, reply) => {
    const { keyId } = parseWith(KeyIdParams, request.params);
    await runKeys.revoke(keyId);
    return reply.code(204).send();
  });

  // ---- 沙箱里的 agent 用：只认 Bearer 临时 Key，付费人和归属由 Key 决定 ----
  // 沙箱经入口代理只能访问这两条路径（见 infra/images/sandbox-ingress）。
  app.post('/run/v1/chat/completions', async (request, reply) =>
    completions(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
  app.post('/run/v1/decisions', async (request, reply) =>
    decide(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
}
