// 一次模型调用的完整计量流程：冻结 → 调上游 → 转发并读取用量 → 按实际花费结算（失败则退回冻结）。
import { randomUUID } from 'node:crypto';
import { HoldResult, SettleResult } from '@oasis/contracts/billing';
import type { ChatCompletionRequest } from '@oasis/contracts/model-gateway';
import { createSseParser, HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';
import type { ModelPrice, ProviderClient } from '../adapters/openrouter.ts';
import type { CallsRepo } from '../repo/calls-repo.ts';
import { actualCostMicro, estimateHoldMicro, type Usage } from './pricing.ts';

export interface PreparedCall {
  id: string;
  holdId: string;
  payerId: string;
  requestId: string;
  body: ChatCompletionRequest & { max_tokens: number };
  price: ModelPrice | undefined;
}

const decoder = () => new TextDecoder();

export function createChatService(deps: {
  provider: ProviderClient;
  billing: ServiceClient;
  repo: CallsRepo;
  prices: () => Map<string, ModelPrice>;
  defaultMaxTokens: number;
  fallbackHoldMicro: number;
  logger: Logger;
}) {
  const { provider, billing, repo, logger } = deps;

  async function release(call: PreparedCall, error: string): Promise<void> {
    await billing
      .json('POST', `/internal/holds/${call.holdId}/release`, {
        body: {},
        requestId: call.requestId,
      })
      .catch((err: unknown) =>
        logger.error({ err, holdId: call.holdId }, '退回冻结失败，等待过期自动回收'),
      );
    await repo.finish(call.id, { status: 'failed', error, chargedMicro: 0 });
  }

  async function settle(
    call: PreparedCall,
    usage: Usage | undefined,
    completionChars: number,
    error?: string,
  ) {
    const { costMicro, source } = actualCostMicro({
      usage,
      price: call.price,
      messages: call.body.messages,
      completionChars,
    });
    let chargedMicro: number | null = null;
    try {
      ({ chargedMicro } = await billing.json('POST', `/internal/holds/${call.holdId}/settle`, {
        body: {
          costMicro,
          detail: { model: call.body.model, callId: call.id, costSource: source },
        },
        requestId: call.requestId,
        schema: SettleResult,
      }));
    } catch (err) {
      logger.error({ err, holdId: call.holdId, costMicro }, '结算失败，冻结将过期退回');
    }
    await repo.finish(call.id, {
      status: error ? 'failed' : 'succeeded',
      error: error ?? null,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      upstreamCostMicro: costMicro,
      chargedMicro,
      costSource: source,
    });
  }

  return {
    /** 冻结额度并登记调用。额度不够时抛 402，上游不会被调用。 */
    async prepare(input: {
      payerId: string;
      requestId: string;
      body: ChatCompletionRequest;
    }): Promise<PreparedCall> {
      if (!provider.configured) {
        throw new HttpError(503, 'provider_not_configured', '模型服务还没有配置 API Key');
      }
      const body = { ...input.body, max_tokens: input.body.max_tokens ?? deps.defaultMaxTokens };
      const price = deps.prices().get(body.model);
      const amountMicro = price
        ? estimateHoldMicro(price, body.messages, body.max_tokens)
        : deps.fallbackHoldMicro;
      const id = randomUUID();
      const { holdId } = await billing.json('POST', '/internal/holds', {
        body: { userId: input.payerId, amountMicro, reason: 'model_call', ref: `call:${id}` },
        requestId: input.requestId,
        schema: HoldResult,
      });
      await repo.start({
        id,
        payerId: input.payerId,
        model: body.model,
        requestId: input.requestId,
        holdId,
      });
      return { id, holdId, payerId: input.payerId, requestId: input.requestId, body, price };
    },

    /** 调上游。还没开始返回内容就失败时退回冻结，并抛出给调用方的错误。 */
    async open(call: PreparedCall, signal: AbortSignal): Promise<Response> {
      let response: Response;
      try {
        response = await provider.chatCompletions(
          { ...call.body, usage: { include: true } },
          signal,
        );
      } catch (err) {
        await release(call, `上游连接失败：${String(err)}`);
        throw new HttpError(503, 'provider_unavailable', '模型服务暂时连不上', { cause: err });
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        await release(call, `上游返回 ${response.status}：${detail}`);
        logger.warn({ status: response.status, detail, model: call.body.model }, '上游拒绝了请求');
        throw new HttpError(502, 'provider_error', '模型服务返回了错误，请稍后再试');
      }
      return response;
    },

    /** 流式：把上游的 SSE 原样转给调用方，同时读出用量，结束后结算。 */
    async pump(
      call: PreparedCall,
      response: Response,
      write: (chunk: string) => void,
    ): Promise<void> {
      let usage: Usage | undefined;
      let completionChars = 0;
      const parser = createSseParser((data) => {
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as {
            usage?: Usage;
            choices?: { delta?: { content?: string } }[];
          };
          if (chunk.usage) usage = chunk.usage;
          completionChars += chunk.choices?.[0]?.delta?.content?.length ?? 0;
        } catch {
          // 不是 JSON 的事件照样转发，只是不参与计量
        }
      });
      const text = decoder();
      let error: string | undefined;
      try {
        for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
          const chunk = text.decode(bytes, { stream: true });
          parser.push(chunk);
          write(chunk);
        }
        parser.end();
      } catch (err) {
        error = `流式传输中断：${String(err)}`;
        write(
          `data: ${JSON.stringify({ error: { code: 'stream_interrupted', message: '回复中断了' } })}\n\n`,
        );
      }
      await settle(call, usage, completionChars, error);
    },

    /** 非流式：等上游完整返回，结算后把结果交给调用方。 */
    async finishJson(call: PreparedCall, response: Response): Promise<unknown> {
      const result = (await response.json()) as {
        usage?: Usage;
        choices?: { message?: { content?: string } }[];
      };
      await settle(call, result.usage, result.choices?.[0]?.message?.content?.length ?? 0);
      return result;
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
