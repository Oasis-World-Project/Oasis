// 一次模型调用的完整计量流程：冻结 → 调上游 → 转发并读取用量 → 按实际花费结算（失败则退回冻结）。
import type { ChatCompletionRequest } from '@oasis/contracts/model-gateway';
import { createSseParser, HttpError } from '@oasis/service-kit';
import type { ModelPrice, ProviderClient } from '../adapters/openrouter.ts';
import type { Caller, MeteredCall, Meter } from './metering.ts';
import { actualCostMicro, estimateHoldMicro, USD_TO_MICRO, type Usage } from './pricing.ts';

export interface PreparedCall extends MeteredCall {
  /** 发给上游的请求体（调用方没给输出上限时补上 max_tokens） */
  body: ChatCompletionRequest;
  /** 输出 token 上限，用于估算冻结金额 */
  maxOutputTokens: number;
  /** 消息之外也要计入输入的字符数（工具定义） */
  extraChars: number;
  price: ModelPrice | undefined;
  reportCost: boolean;
  /**
   * 调用方的会话编号（dsh 每次都在 x-session-id 头里带上自己的会话 ID）。原样交给 OpenRouter 的
   * session_id：同一会话的请求固定送到同一家供应商，才吃得到上一次的缓存；不传时 OpenRouter
   * 要等发现命中之后才开始固定，中途换家缓存就丢了（2026-11-14 查到网关一直没往下传）。
   */
  sessionId?: string;
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

/** 供应商在流里报的错写成一句话（有 code 带上 code），最多 300 字 */
function errorText(error: unknown): string {
  const { code, message } = (typeof error === 'object' && error ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const text = typeof message === 'string' ? message : JSON.stringify(error);
  const prefix = typeof code === 'string' || typeof code === 'number' ? `${code} ` : '';
  return `${prefix}${text}`.slice(0, 300);
}

export function createChatService(deps: {
  provider: ProviderClient;
  meter: Meter;
  prices: () => Map<string, ModelPrice>;
  defaultMaxTokens: number;
  /** 单次回答的输出上限（调用方要得更多时压到这里），见 config 的 MAX_OUTPUT_TOKENS */
  maxOutputTokens: number;
  fallbackHoldMicro: number;
  /**
   * 中断时去供应商那边查实际花费的等待间隔：生成记录要过几秒才查得到，查不到再按估算记。
   * 测试里给空数组或很短的间隔。
   */
  generationLookupDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}) {
  const { provider, meter } = deps;
  // 只在中断时查（正常结束的有用量）：最多多等约 7 秒
  const lookupDelays = deps.generationLookupDelaysMs ?? [1_000, 2_000, 4_000];
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** 供应商记下的这次生成的实际花费（美元）；查不到返回 undefined，不抛错 */
  async function lookupCost(generationId: string): Promise<number | undefined> {
    for (const delay of lookupDelays) {
      await sleep(delay);
      const cost = await provider.generationCost(generationId).catch(() => undefined);
      if (cost !== undefined) return cost;
    }
    return undefined;
  }

  async function settle(
    call: PreparedCall,
    usage: Usage | undefined,
    completionChars: number,
    error?: string,
    generationId?: string,
  ) {
    // 流断了、没拿到用量（多半是用户停下了任务）：先按生成 ID 问供应商实际扣了多少，
    // 问不到才按消息估算（2026-11-08：估算曾把一次 $0.03 的调用记成 $4.11）
    const missing = typeof usage?.cost !== 'number' && typeof usage?.prompt_tokens !== 'number';
    const looked = missing && generationId ? await lookupCost(generationId) : undefined;
    const cost =
      looked !== undefined && looked >= 0
        ? { costMicro: Math.round(looked * USD_TO_MICRO), source: 'provider' as const }
        : actualCostMicro({
            usage,
            price: call.price,
            messages: call.body.messages,
            completionChars,
            extraChars: call.extraChars,
          });
    await meter.settle(call, cost, usage, error);
    return cost.costMicro;
  }

  return {
    /** 冻结额度并登记调用。额度不够时抛 402，上游不会被调用。 */
    async prepare(input: {
      caller: Caller;
      requestId: string;
      body: ChatCompletionRequest;
      sessionId?: string;
    }): Promise<PreparedCall> {
      if (!provider.configured) {
        throw new HttpError(503, 'provider_not_configured', '模型服务还没有配置 API Key');
      }
      const { max_cost_micro: maxCostMicro, report_cost: reportCost, ...providerBody } = input.body;
      const requested = providerBody.max_completion_tokens ?? providerBody.max_tokens;
      const modelMax = deps.prices().get(providerBody.model)?.capabilities?.maxTokens;
      // 输出上限不超过模型实际能输出的，也不超过单次回答的上限：dsh 会按整个上下文窗口要（约 93 万），
      // 供应商按这个数预先核算花费，额度稍紧就整单拒绝，冻结金额也会虚高（2026-11-06）
      const maxOutputTokens = Math.min(
        requested ?? modelMax ?? deps.defaultMaxTokens,
        modelMax ?? Infinity,
        deps.maxOutputTokens,
      );
      const field =
        providerBody.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens';
      const body =
        requested === maxOutputTokens
          ? providerBody
          : { ...providerBody, [field]: maxOutputTokens };
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
        ...(maxCostMicro === undefined ? {} : { maxCostMicro }),
        requestId: input.requestId,
      });
      return {
        ...call,
        body,
        maxOutputTokens,
        extraChars,
        price,
        reportCost: reportCost === true || maxCostMicro !== undefined,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      };
    },

    /** 调上游。还没开始返回内容就失败时退回冻结，并抛出给调用方的错误。 */
    open(call: PreparedCall, signal: AbortSignal): Promise<Response> {
      return meter.callUpstream(call, () =>
        provider.chatCompletions(
          {
            ...call.body,
            usage: { include: true },
            ...(call.sessionId ? { session_id: call.sessionId } : {}),
          },
          signal,
        ),
      );
    },

    /** 流式：把上游的 SSE 原样转给调用方，同时读出用量，结束后结算。 */
    async pump(
      call: PreparedCall,
      response: Response,
      write: (chunk: string) => void,
      options: { transportErrors?: 'message' | 'disconnect' } = {},
    ): Promise<void> {
      let usage: Usage | undefined;
      let completionChars = 0;
      let completed = false;
      /** 供应商在流里报的错（流已经开始后出错只能这样报），记进调用记录，排查时才知道是谁断的 */
      let providerError: string | undefined;
      /** OpenRouter 把这次请求转给了哪家（每个片段都带着）；断了记进原因，同一型号各家的限制不一样 */
      let servedBy: string | undefined;
      /** 供应商给这次生成的 ID（每个片段都带着），中断时凭它查实际花费 */
      let generationId: string | undefined;
      const parser = createSseParser((data) => {
        if (data === '[DONE]') {
          completed = true;
          return;
        }
        try {
          const chunk = JSON.parse(data) as {
            id?: unknown;
            provider?: unknown;
            usage?: Usage;
            error?: unknown;
            choices?: { delta?: Parameters<typeof deltaChars>[0] }[];
          };
          if (!generationId && typeof chunk.id === 'string' && chunk.id) generationId = chunk.id;
          if (!servedBy && typeof chunk.provider === 'string' && chunk.provider)
            servedBy = chunk.provider;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.error) providerError = errorText(chunk.error);
          const delta = chunk.choices?.[0]?.delta;
          if (delta) completionChars += deltaChars(delta);
        } catch {
          // 不是 JSON 的事件照样转发，只是不参与计量
        }
      });
      const text = decoder();
      let error: string | undefined;
      let terminalChunk: string | undefined;
      try {
        for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
          const chunk = text.decode(bytes, { stream: true });
          parser.push(chunk);
          // 客户端收到 DONE 就可能关闭连接；先结算，再发出包含 DONE 的最后一块。
          if (completed) {
            terminalChunk = chunk;
            break;
          }
          write(chunk);
        }
        parser.end();
        if (providerError) error = `供应商在流里报错：${providerError}`;
        else if (!completed) error = '流式传输未收到完成标记';
      } catch (err) {
        error = `流式传输中断：${String(err)}`;
      }
      if (error && servedBy) error += `（OpenRouter 转给了 ${servedBy}）`;
      if (!completed && options.transportErrors !== 'disconnect')
        write(
          `data: ${JSON.stringify({ error: { code: 'stream_interrupted', message: '回复中断了' } })}\n\n`,
        );
      await settle(call, usage, completionChars, error, generationId);
      if (!completed && options.transportErrors === 'disconnect')
        throw new HttpError(503, 'stream_interrupted', '模型传输中断，已记录费用');
      if (terminalChunk !== undefined) write(terminalChunk);
    },

    /** 非流式：等上游完整返回，结算后把结果交给调用方。 */
    async finishJson(call: PreparedCall, response: Response): Promise<unknown> {
      let result: {
        usage?: Usage;
        choices?: { message?: Parameters<typeof deltaChars>[0] }[];
      };
      try {
        result = (await response.json()) as typeof result;
      } catch {
        await settle(call, undefined, 0, '非流式响应中断或 JSON 损坏，未取得完整用量');
        throw new HttpError(502, 'response_interrupted', '模型响应未完整读取，用量按估算记录');
      }
      const message = result.choices?.[0]?.message;
      const costMicro = await settle(call, result.usage, message ? deltaChars(message) : 0);
      return call.reportCost ? { ...result, oasis: { costMicro } } : result;
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
