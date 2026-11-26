import { OASIS_HEADERS } from '@oasis/contracts/common';
import { AvatarSessionStartBody, AvatarStopBody } from '@oasis/contracts/avatar';
import {
  AskConfirmationBody,
  ChatCompletionRequest,
  ComputeHoldBody,
  ComputeSettleBody,
  CreateRunKeyBody,
  RebindRunKeyBody,
  DecideConfirmationBody,
  DecisionRequest,
  type ModelCapabilities,
  type RunActivity,
  ToolCallBody,
} from '@oasis/contracts/model-gateway';
import {
  fileResponseHeaders,
  parseWith,
  requirePayerId,
  type ServiceApp,
} from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AvatarService } from '../service/avatar-service.ts';
import type { ChatService } from '../service/chat-service.ts';
import type { ComputeService } from '../service/compute-service.ts';
import type { DecisionService } from '../service/decision-service.ts';
import type { Caller } from '../service/metering.ts';
import type { ModelScope } from '../service/model-scope.ts';
import type { RunKeyService } from '../service/run-key-service.ts';
import type { ToolService } from '../service/tool-service.ts';

const KeyIdParams = z.object({ keyId: z.uuid() });
const ToolParams = z.object({ key: z.string().min(1).max(50) });
const JobParams = z.object({ jobId: z.uuid() });
const CallIdParams = z.object({ callId: z.uuid() });
const AvatarSessionParams = z.object({ sessionId: z.uuid() });
/** 工具的参数里可能带着要转写的录音（base64），放宽请求体上限（入口代理是 50MB） */
const TOOL_BODY = { bodyLimit: 40 * 1024 * 1024 };
const RunIdParams = z.object({ runId: z.uuid() });
const ConversationParams = z.object({ conversationId: z.uuid() });
const ConfirmationParams = z.object({ confirmationId: z.uuid() });
/** 等确认结果最多等几秒（长轮询；入口代理和 gateway 的读超时都比这长） */
const WaitQuery = z.object({ wait: z.coerce.number().int().min(0).max(30).default(0) });

/** 内部调用方：付费人在 x-oasis-payer-id 头里 */
const internalCaller = (request: FastifyRequest): Caller => ({ payerId: requirePayerId(request) });

/** 目录按「只用国内模型」过滤（?domesticOnly=true）；没带就列全部 */
const ScopeQuery = z.object({
  domesticOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
const domesticOnlyOf = (request: FastifyRequest) =>
  parseWith(ScopeQuery, request.query).domesticOnly;

/** 客户端断开时取消上游请求（已产生的部分照样按实际花费结算）。 */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}

/**
 * 调用方的会话编号：dsh 按 OpenRouter 的约定放在 x-session-id 头里（OpenRouter 限 256 字）。
 * 格式不对就当没带，不因为它拒绝调用。
 */
const SessionId = z
  .string()
  .regex(/^[\w.:-]{1,256}$/)
  .optional()
  .catch(undefined);

/** OpenAI 兼容的 chat completions：流式时原样转发 SSE。内部和沙箱共用。 */
function createCompletions(chat: ChatService) {
  return async function completions(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const body = parseWith(ChatCompletionRequest, request.body);
    const sessionId = SessionId.parse(request.headers['x-session-id']);
    const prepared = await chat.prepare({
      caller,
      requestId: request.id,
      body,
      ...(sessionId ? { sessionId } : {}),
    });
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
    try {
      await chat.pump(
        prepared,
        upstream,
        (chunk) => {
          if (!reply.raw.destroyed) reply.raw.write(chunk);
        },
        { transportErrors: caller.runId ? 'disconnect' : 'message' },
      );
    } catch (err) {
      // 原生执行器应看到真实传输失败，由自己的 provider 重试；不能改造成不可重试的模型消息。
      reply.raw.destroy();
      request.log.warn({ err }, '模型流未完成，连接已关闭');
      return;
    }
    reply.raw.end();
  };
}

export function registerRoutes(
  app: ServiceApp,
  services: {
    modelRequestMaxBytes: number;
    chat: ChatService;
    decisions: DecisionService;
    runKeys: RunKeyService;
    tools: ToolService;
    compute: ComputeService;
    avatars: AvatarService;
    scope: ModelScope;
    /** 对话里一轮已经结算的花费和用过的工具 */
    runSpend: (runId: string, payerId: string) => Promise<Omit<RunActivity, 'confirmations'>>;
    executionModels: () => Promise<ModelCapabilities[]>;
  },
): void {
  const { chat, decisions, runKeys, tools, avatars } = services;
  const completions = createCompletions(chat);
  const modelBody = { bodyLimit: services.modelRequestMaxBytes };

  async function useTool(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const { key } = parseWith(ToolParams, request.params);
    const { args, max_cost_micro, idempotency_key, confirmation_id } = parseWith(
      ToolCallBody,
      request.body,
    );
    return tools.call({
      idempotencyKey: idempotency_key,
      caller,
      key,
      args,
      requestId: request.id,
      signal: abortOnClose(reply),
      ...(max_cost_micro === undefined ? {} : { maxCostMicro: max_cost_micro }),
      ...(confirmation_id ? { confirmationId: confirmation_id } : {}),
    });
  }

  function toolJob(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const { jobId } = parseWith(JobParams, request.params);
    return tools.job(caller, jobId, abortOnClose(reply));
  }

  async function decide(caller: Caller, request: FastifyRequest, reply: FastifyReply) {
    const body = parseWith(DecisionRequest, request.body);
    return decisions.decide({ caller, requestId: request.id, body, signal: abortOnClose(reply) });
  }

  // ---- 内部服务用（gateway 不转发 /internal）：付费人放在 x-oasis-payer-id 头里 ----
  app.post('/internal/v1/chat/completions', modelBody, (request, reply) =>
    completions(internalCaller(request), request, reply),
  );
  app.post('/internal/v1/decisions', modelBody, (request, reply) =>
    decide(internalCaller(request), request, reply),
  );

  /** 工具目录；调用工具 */
  app.get('/internal/v1/tools', async (request) => ({
    tools: await tools.list(domesticOnlyOf(request)),
  }));
  /** 能开一轮的执行模型（harness 开一轮前核对）；打开了「只用国内模型」的只列国内厂商的 */
  app.get('/internal/v1/models/execution', async (request) => {
    const allowed = services.scope.filterFor(domesticOnlyOf(request));
    const models = await services.executionModels();
    return { models: models.filter((model) => allowed(model.id)) };
  });
  /** 对话里一轮的花费、用过的工具和在等用户点的确认卡：conversation 在一轮进行中和结束后读 */
  app.get('/internal/v1/runs/:runId', async (request): Promise<RunActivity> => {
    const { runId } = parseWith(RunIdParams, request.params);
    const [spend, confirmations] = await Promise.all([
      services.runSpend(runId, requirePayerId(request)),
      runKeys.pending(runId),
    ]);
    return { ...spend, confirmations };
  });
  /** 用户点确认卡（conversation 核对过是这个私聊正在进行的这一轮） */
  app.post('/internal/v1/confirmations/:confirmationId/decide', async (request) => {
    const { confirmationId } = parseWith(ConfirmationParams, request.params);
    const { runId, decision } = parseWith(DecideConfirmationBody, request.body);
    return runKeys.decide(confirmationId, runId, decision);
  });
  /** 删对话（真删除）：拦住迟到的工具提交，取消在途的长任务，清掉工具的结果文件和确认卡；可以重复调用 */
  app.post('/internal/conversations/:conversationId/purge', async (request, reply) => {
    const { conversationId } = parseWith(ConversationParams, request.params);
    await tools.purgeConversation(conversationId);
    await runKeys.purgeConversation(conversationId);
    return reply.code(204).send();
  });
  app.post('/internal/v1/tools/:key', TOOL_BODY, (request, reply) =>
    useTool(internalCaller(request), request, reply),
  );
  /** 长任务（视频）的进度和结果 */
  app.get('/internal/v1/tools/jobs/:jobId', (request, reply) =>
    toolJob(internalCaller(request), request, reply),
  );
  app.post('/internal/v1/tools/jobs/:jobId/cancel', async (request) => {
    await tools.cancel(internalCaller(request), parseWith(JobParams, request.params).jobId);
    return { accepted: true };
  });
  app.post('/internal/v1/tools/runs/:runId/cancel', async (request) => {
    const { runId } = parseWith(RunIdParams, request.params);
    await tools.cancelRun(internalCaller(request), runId);
    return { accepted: true };
  });

  /** 算力（harness 用）：开沙箱前冻结，销毁后按实际时长结算 */
  app.get('/internal/v1/compute/quote', async (request) => {
    const { cores, maxMs } = parseWith(
      z.object({
        cores: z.coerce.number().positive().max(64),
        maxMs: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 3600_000),
      }),
      request.query,
    );
    return services.compute.quote(cores, maxMs);
  });
  app.post('/internal/v1/compute', async (request, reply) => {
    const body = parseWith(ComputeHoldBody, request.body);
    return reply.code(201).send(await services.compute.hold({ ...body, requestId: request.id }));
  });
  app.post('/internal/v1/compute/:callId/settle', async (request, reply) => {
    const { callId } = parseWith(CallIdParams, request.params);
    await services.compute.settle(callId, parseWith(ComputeSettleBody, request.body));
    return reply.code(204).send();
  });
  app.post('/internal/v1/compute/runs/:runId/recover', async (request, reply) => {
    const { runId } = parseWith(RunIdParams, request.params);
    await services.compute.recover(
      runId,
      parseWith(
        z.object({
          payerId: z.uuid(),
          cores: z.number().positive().max(64),
          endedAt: z.iso.datetime(),
        }),
        request.body,
      ),
    );
    return reply.code(204).send();
  });
  app.get('/internal/v1/compute/:callId', async (request) => {
    const { callId } = parseWith(CallIdParams, request.params);
    return services.compute.outcome(callId);
  });

  // ---- 实时数字人：canvas 替用户开、结束会话 ----
  app.post('/internal/avatar/sessions', async (request, reply) => {
    const body = parseWith(AvatarSessionStartBody, request.body);
    return reply.code(201).send(await avatars.start(requirePayerId(request), body));
  });
  app.post('/internal/avatar/sessions/:sessionId/stop', async (request, reply) => {
    const { sessionId } = parseWith(AvatarSessionParams, request.params);
    const { reason } = parseWith(AvatarStopBody, request.body ?? {});
    await avatars.stop(requirePayerId(request), sessionId, reason);
    return reply.code(204).send();
  });
  app.get('/internal/avatar/sessions/:sessionId', async (request) => {
    const { sessionId } = parseWith(AvatarSessionParams, request.params);
    return avatars.view(requirePayerId(request), sessionId);
  });

  /** harness 为对话里的一轮签发临时 Key；明文只在这里返回一次。 */
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
  /** 同一个 dsh 接着做下一轮：它手里的 Key 改归到新的一轮 */
  app.post('/internal/run-keys/:keyId/rebind', async (request, reply) => {
    const { keyId } = parseWith(KeyIdParams, request.params);
    await runKeys.rebind(keyId, parseWith(RebindRunKeyBody, request.body));
    return reply.code(204).send();
  });
  app.post('/internal/run-keys/:keyId/renew', async (request, reply) => {
    const { keyId } = parseWith(KeyIdParams, request.params);
    const { ttlSeconds } = parseWith(CreateRunKeyBody.pick({ ttlSeconds: true }), request.body);
    await runKeys.renew(keyId, ttlSeconds);
    return reply.code(204).send();
  });

  // ---- 沙箱里的 agent 用：只认 Bearer 临时 Key，付费人和归属由 Key 决定 ----
  // 沙箱经入口代理只能访问这几条路径（见 infra/images/sandbox-ingress）。
  app.post('/run/v1/chat/completions', modelBody, async (request, reply) =>
    completions(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
  app.post('/run/v1/decisions', modelBody, async (request, reply) =>
    decide(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
  // 确认卡：dsh 插件登记（AI 要做超出权限的事）、等结果、不等了收回；oasis-tool 等花钱工具的确认
  app.post('/run/v1/confirmations', async (request, reply) => {
    const caller = await runKeys.authenticate(request.headers.authorization);
    const { text, callId } = parseWith(AskConfirmationBody, request.body);
    return reply.code(201).send(await runKeys.ask(caller, text, callId));
  });
  app.get('/run/v1/confirmations/:confirmationId', async (request) => {
    const caller = await runKeys.authenticate(request.headers.authorization);
    const { confirmationId } = parseWith(ConfirmationParams, request.params);
    const { wait } = parseWith(WaitQuery, request.query);
    return runKeys.wait(caller, confirmationId, wait * 1000);
  });
  app.post('/run/v1/confirmations/:confirmationId/cancel', async (request) =>
    runKeys.withdraw(
      await runKeys.authenticate(request.headers.authorization),
      parseWith(ConfirmationParams, request.params).confirmationId,
    ),
  );
  // 沙箱里的 oasis-tool：看有哪些工具、调用工具
  app.get('/run/v1/tools', async (request) => {
    const caller = await runKeys.authenticate(request.headers.authorization);
    return { tools: await tools.list(caller.domesticOnly, caller.noWeb) };
  });
  app.post('/run/v1/tools/:key', TOOL_BODY, async (request, reply) =>
    useTool(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
  app.get('/run/v1/tools/jobs/:jobId', async (request, reply) =>
    toolJob(await runKeys.authenticate(request.headers.authorization), request, reply),
  );
  app.post('/run/v1/tools/jobs/:jobId/cancel', async (request) => {
    await tools.cancel(
      await runKeys.authenticate(request.headers.authorization),
      parseWith(JobParams, request.params).jobId,
    );
    return { accepted: true };
  });
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );
  app.put(
    '/run/v1/tools/jobs/:jobId/inputs/:fileId',
    { bodyLimit: 100 * 1024 ** 2 },
    async (request) => {
      const caller = await runKeys.authenticate(request.headers.authorization);
      const { jobId, fileId } = parseWith(
        JobParams.extend({ fileId: z.string().regex(/^\d{1,2}$/) }),
        request.params,
      );
      return tools.upload(caller, jobId, fileId, request.body as import('node:stream').Readable);
    },
  );
  app.post('/run/v1/tools/jobs/:jobId/submit', async (request) =>
    tools.submit(
      await runKeys.authenticate(request.headers.authorization),
      parseWith(JobParams, request.params).jobId,
    ),
  );
  app.post('/internal/v1/tools/jobs/:jobId/reconcile', async (request) => {
    const evidence = parseWith(
      z.object({
        costMicro: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        billId: z.string().min(1).max(200),
        stopped: z.literal(true),
      }),
      request.body,
    );
    await tools.reconcile(
      internalCaller(request),
      parseWith(JobParams, request.params).jobId,
      evidence,
    );
    return { accepted: true };
  });
  const fileParams = JobParams.extend({ fileId: z.string().regex(/^\d{1,3}$/) });
  app.get('/run/v1/tools/jobs/:jobId/files/:fileId', async (request, reply) => {
    const caller = await runKeys.authenticate(request.headers.authorization);
    const { jobId, fileId } = parseWith(fileParams, request.params);
    const file = await tools.file(caller, jobId, fileId);
    return reply
      .headers(fileResponseHeaders(file.mediaType, file.name, true))
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256)
      .send(file.content);
  });
  app.get('/internal/v1/tools/jobs/:jobId/files/:fileId', async (request, reply) => {
    const { jobId, fileId } = parseWith(fileParams, request.params);
    const file = await tools.file(internalCaller(request), jobId, fileId);
    return reply
      .type(file.mediaType)
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256)
      .send(file.content);
  });
}
