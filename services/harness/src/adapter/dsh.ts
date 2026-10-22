// dsh 的适配层：全仓只有这里认识 DeepSeek Harness（AGENTS.md B.3）。
// 对外只暴露 Oasis 自己的概念：沙箱里的目录约定、环境变量、一次 agent 会话、翻译后的运行事件。
// dsh 升级（SDK 协议、事件格式变化）只改这个目录和 profile/ 下的组合。
import type { Readable, Writable } from 'node:stream';
import type { RunEventKind } from '@oasis/contracts/harness';
import { createJsonRpcClient } from './jsonrpc.ts';

/** 沙箱镜像里的目录约定（与 infra/images/harness-sandbox-base/Dockerfile 一致） */
export const SANDBOX_PATHS = {
  workdir: '/workspace',
  inputs: '/workspace/in',
  outputs: '/workspace/out',
  /** dsh 的会话存储（互审打回重做、崩溃恢复时用来接着原上下文） */
  sessions: '/home/node/.dsh/sessions',
} as const;

/** dsh 里指向 model-gateway 的模型路由名（profile/cordis.patch.yml 里定义） */
const PROVIDER = 'oasis';

/** 沙箱的环境变量。runKey 是密钥，调用方不得记进日志。 */
export function sandboxEnv(input: {
  modelBaseUrl: string;
  runKey: string;
  model: string;
}): Record<string, string> {
  return {
    OASIS_MODEL_BASE_URL: input.modelBaseUrl,
    OASIS_RUN_KEY: input.runKey,
    OASIS_MODEL: input.model,
    OASIS_MODELS: JSON.stringify([{ id: input.model, name: input.model }]),
  };
}

export interface AgentEvent {
  kind: RunEventKind;
  data: Record<string, unknown>;
}

/** 工具参数和结果在事件里最多保留这么多字符（完整内容在 dsh 会话存档里） */
const MAX_EVENT_TEXT = 4000;
const clip = (text: string) =>
  text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…（已截断）` : text;

interface Block {
  type?: string;
  text?: string;
}
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Block[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    : typeof content === 'string'
      ? content
      : '';

/** 把 dsh 的一条通知翻译成 Oasis 的运行事件；不关心的返回 undefined。 */
export function translateNotification(method: string, params: unknown): AgentEvent | undefined {
  const p = (params ?? {}) as { status?: string; event?: { type?: string; data?: unknown } };
  if (method === 'session.status' && typeof p.status === 'string') {
    return { kind: 'status', data: { status: p.status } };
  }
  if (method !== 'session.event' || !p.event?.type) return undefined;
  const data = (p.event.data ?? {}) as Record<string, unknown>;
  switch (p.event.type) {
    case 'user/message': {
      // dsh 每一步还会插一条「运行时上下文」用户消息，只保留真正来自用户的
      const source = data.source as { kind?: string } | undefined;
      if (source?.kind !== 'user') return undefined;
      return { kind: 'user_message', data: { text: clip(textOf(data.content)) } };
    }
    case 'assistant/message': {
      const message = data.message as { content?: unknown } | undefined;
      const text = textOf(message?.content);
      return text ? { kind: 'assistant_text', data: { text: clip(text) } } : undefined;
    }
    case 'tool/call':
      return {
        kind: 'tool_call',
        data: {
          callId: data.callId,
          name: data.name,
          arguments: clip(String(data.arguments ?? '')),
        },
      };
    case 'tool/result': {
      const message = data.message as
        { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
      const error = data.error as { reason?: string } | undefined;
      return {
        kind: 'tool_result',
        data: {
          callId: message?.toolCallId,
          ok: !message?.isError,
          text: clip(textOf(message?.content)),
          ...(error?.reason ? { error: clip(error.reason) } : {}),
        },
      };
    }
    case 'turn/end': {
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === 'error') {
        return { kind: 'error', data: { message: clip(reason.error?.message ?? '模型调用失败') } };
      }
      return { kind: 'turn_end', data: { reason: reason?.kind ?? 'unknown' } };
    }
    default:
      return undefined;
  }
}

/**
 * 沙箱里的一个 dsh 运行时（SDK 模式，经 stdin/stdout 说 JSON-RPC）。
 * 一次运行只用一个会话，会话 ID 就是运行 ID。
 */
export function connectAgent(io: {
  stdin: Writable;
  stdout: Readable;
  sessionId: string;
  onEvent: (event: AgentEvent) => void;
}) {
  /** 最近一轮是怎么结束的：只要最后一轮是 error，这次运行就算失败 */
  let lastError: string | undefined;
  const rpc = createJsonRpcClient({
    input: io.stdout,
    output: io.stdin,
    onNotification: (method, params) => {
      const event = translateNotification(method, params);
      if (!event) return;
      if (event.kind === 'error') lastError = String(event.data.message);
      if (event.kind === 'turn_end') lastError = undefined;
      io.onEvent(event);
    },
  });
  const session = { sessionId: io.sessionId };

  return {
    /** 握手：选定模型。dsh 起来要一两秒，给足时间 */
    initialize: (model: string, cwd: string) =>
      rpc.request('initialize', { cwd, provider: PROVIDER, model }, 60_000),
    /** 交一条用户消息：运行中发的会排在当前这一轮之后处理 */
    prompt: (text: string) =>
      rpc.request(
        'session/prompt',
        { ...session, contentBlocks: [{ type: 'text', text }] },
        30_000,
      ),
    /** 等到会话空闲（所有排队的消息都处理完）；返回失败原因，成功时为 undefined */
    async waitIdle(): Promise<string | undefined> {
      try {
        await rpc.request('session/wait', session);
      } catch (err) {
        return lastError ?? (err instanceof Error ? err.message : String(err));
      }
      return lastError;
    },
    shutdown: () => rpc.request('shutdown', undefined, 10_000),
    /** 沙箱没了：让还在等的请求立刻失败 */
    abort: (err: Error) => rpc.abort(err),
  };
}

export type AgentConnection = ReturnType<typeof connectAgent>;
