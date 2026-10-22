// 一次模型调用的完整计量流程：冻结 → 调上游 → 转发并读取用量 → 按实际花费结算（失败则退回冻结）。
import type { ChatCompletionRequest } from '@oasis/contracts/model-gateway';
import { createSseParser, HttpError } from '@oasis/service-kit';
import type { ModelPrice, ProviderClient } from '../adapters/openrouter.ts';
import type { Caller, MeteredCall, Meter } from './metering.ts';
import { actualCostMicro, estimateHoldMicro, type Usage } from './pricing.ts';

export interface PreparedCall extends MeteredCall {
  /** 发给上游的请求体（调用方没给输出上限时补上 max_tokens） */
  body: ChatCompletionRequest;
  /** 输出 token 上限，用于估算冻结金额 */
  maxOutputTokens: number;
  /** 消息之外也要计入输入的字符数（工具定义） */
  extraChars: number;
  price: ModelPrice | undefined;
}

const decoder = () => new TextDecoder();

/** 流式片段里本次生成的字符数（文字和工具调用参数），用于没有用量信息时估算花费。 */
function deltaChars(delta: {
  content?: string | null;
  tool_calls?: { function?: { arguments?: string } }[];
}): number {
  const toolChars = (delta.tool_calls ?? []).reduce(
    (total, call) => total + (call.function?.arguments?.length ?? 0),
    0,
  );
  return (delta.content?.length ?? 0) + toolChars;
}

export function createChatService(deps: {
  provider: ProviderClient;
  meter: Meter;
  prices: () => Map<string, ModelPrice>;
  defaultMaxTokens: number;
  fallbackHoldMicro: number;
}) {
  const { provider, meter } = deps;

  async function settle(
    call: PreparedCall,
    usage: Usage | undefined,
    completionChars: number,
    error?: string,
  ) {
    const cost = actualCostMicro({
      usage,
      price: call.price,
      messages: call.body.messages,
      completionChars,
      extraChars: call.extraChars,
    });
    await meter.settle(call, cost, usage, error);
  }

  return {
    /** 冻结额度并登记调用。额度不够时抛 402，上游不会被调用。 */
    async prepare(input: {
      caller: Caller;
      requestId: string;
      body: ChatCompletionRequest;
    }): Promise<PreparedCall> {
      if (!provider.configured) {
        throw new HttpError(503, 'provider_not_configured', '模型服务还没有配置 API Key');
      }
      const requested = input.body.max_completion_tokens ?? input.body.max_tokens;
      const maxOutputTokens = requested ?? deps.defaultMaxTokens;
      const body = requested ? input.body : { ...input.body, max_tokens: maxOutputTokens };
      const extraChars = input.body.tools ? JSON.stringify(input.body.tools).length : 0;
      const price = deps.prices().get(body.model);
      const amountMicro = price
        ? estimateHoldMicro(price, body.messages, maxOutputTokens, extraChars)
        : deps.fallbackHoldMicro;
      const call = await meter.hold({
        caller: input.caller,
        kind: 'chat',
        model: body.model,
        amountMicro,
        requestId: input.requestId,
      });
      return { ...call, body, maxOutputTokens, extraChars, price };
    },

    /** 调上游。还没开始返回内容就失败时退回冻结，并抛出给调用方的错误。 */
    open(call: PreparedCall, signal: AbortSignal): Promise<Response> {
      return meter.callUpstream(call, () =>
        provider.chatCompletions({ ...call.body, usage: { include: true } }, signal),
      );
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
            choices?: { delta?: Parameters<typeof deltaChars>[0] }[];
          };
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          if (delta) completionChars += deltaChars(delta);
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
        choices?: { message?: Parameters<typeof deltaChars>[0] }[];
      };
      const message = result.choices?.[0]?.message;
      await settle(call, result.usage, message ? deltaChars(message) : 0);
      return result;
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
