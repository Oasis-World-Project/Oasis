// LiveAvatar（HeyGen 的实时数字人）最小客户端（ADR 0013）。换供应商只换这个文件。
// 管理接口用 X-API-KEY；开始会话用会话令牌（Bearer）。返回统一是 { code, data, message }。
import { z } from 'zod';

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const Envelope = z.looseObject({ data: z.unknown(), message: z.string().nullish() });
const WithId = z.looseObject({ id: z.string().min(1) });
const SessionToken = z.looseObject({ session_id: z.string().min(1), session_token: z.string() });
const Room = z.looseObject({ livekit_url: z.string().min(1), livekit_client_token: z.string() });
const Credits = z.looseObject({ credits_left: z.coerce.number() });

export class LiveAvatarError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AvatarSessionRequest {
  avatarId: string;
  voiceId?: string;
  contextId: string;
  language: string;
  llmConfigurationId: string;
  sandbox: boolean;
  maxSeconds: number;
}

/** 把 LiveAvatar 的错误响应压成一句话（不带请求内容，避免把密钥写进日志） */
function describe(json: unknown): string {
  if (json && typeof json === 'object') {
    const body = json as { message?: unknown; detail?: unknown };
    if (typeof body.message === 'string') return body.message.slice(0, 300);
    if (body.detail !== undefined) return JSON.stringify(body.detail).slice(0, 300);
  }
  return '没有说明';
}

export function createLiveAvatarClient(options: {
  baseUrl: string;
  apiKey: string | undefined;
  fetcher?: Fetcher;
  timeoutMs?: number;
}) {
  const base = options.baseUrl.replace(/\/$/, '');
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    body?: Record<string, unknown>,
    bearer?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else headers['x-api-key'] = options.apiKey ?? '';
    if (body) headers['content-type'] = 'application/json';
    const response = await fetcher(`${base}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // 不是 JSON（如网关错误页）：当作没有说明
      }
    }
    if (!response.ok) {
      throw new LiveAvatarError(
        response.status,
        `LiveAvatar ${method} ${path.split('/').slice(0, 3).join('/')} 返回 ${response.status}：${describe(json)}`,
      );
    }
    return schema.parse(Envelope.parse(json).data);
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    configured: Boolean(options.apiKey),

    async credits(): Promise<number> {
      return (await call('GET', '/v1/users/credits', Credits)).credits_left;
    },

    /** 存一把给 LiveAvatar 回调我们大模型用的 Key（会话专用的临时 Key）；我们的入口说 OpenAI 协议，所以类型是 OPENAI_API_KEY */
    async createSecret(name: string, value: string): Promise<string> {
      const body = { secret_name: name, secret_value: value, secret_type: 'OPENAI_API_KEY' };
      return (await call('POST', '/v1/secrets', WithId, body)).id;
    },
    async deleteSecret(secretId: string): Promise<void> {
      await call('DELETE', `/v1/secrets/${id(secretId)}`, z.unknown());
    },

    /** 自定义大模型：LiveAvatar 每轮对话向 `${baseUrl}/chat/completions` 发 OpenAI 格式的请求 */
    async createLlmConfiguration(input: {
      name: string;
      model: string;
      secretId: string;
      baseUrl: string;
    }): Promise<string> {
      const body = {
        display_name: input.name.slice(0, 255),
        model_name: input.model,
        secret_id: input.secretId,
        base_url: input.baseUrl,
      };
      const created = await call(
        'POST',
        '/v1/llm-configurations',
        z.looseObject({ id: z.string().optional(), llm_configuration_id: z.string().optional() }),
        body,
      );
      const configId = created.id ?? created.llm_configuration_id;
      if (!configId) throw new LiveAvatarError(502, 'LiveAvatar 没有返回大模型配置的编号');
      return configId;
    },
    async deleteLlmConfiguration(configId: string): Promise<void> {
      await call('DELETE', `/v1/llm-configurations/${id(configId)}`, z.unknown());
    },

    /** 人设（系统提示词）和开场白 */
    async createContext(input: {
      name: string;
      prompt: string;
      openingText: string;
    }): Promise<string> {
      const body = {
        name: input.name.slice(0, 64),
        prompt: input.prompt,
        opening_text: input.openingText,
      };
      return (await call('POST', '/v1/contexts', WithId, body)).id;
    },
    async deleteContext(contextId: string): Promise<void> {
      await call('DELETE', `/v1/contexts/${id(contextId)}`, z.unknown());
    },

    async createSessionToken(input: AvatarSessionRequest) {
      const body = {
        mode: 'FULL',
        avatar_id: input.avatarId,
        is_sandbox: input.sandbox,
        max_session_duration: input.maxSeconds,
        llm_configuration_id: input.llmConfigurationId,
        avatar_persona: {
          ...(input.voiceId ? { voice_id: input.voiceId } : {}),
          context_id: input.contextId,
          language: input.language,
        },
      };
      const token = await call('POST', '/v1/sessions/token', SessionToken, body);
      return { providerSessionId: token.session_id, sessionToken: token.session_token };
    },

    /** 开始会话（开始计时扣积分），返回浏览器加入 LiveKit 房间用的地址和令牌 */
    async startSession(sessionToken: string) {
      const room = await call('POST', '/v1/sessions/start', Room, undefined, sessionToken);
      return { livekitUrl: room.livekit_url, livekitToken: room.livekit_client_token };
    },

    async stopSession(providerSessionId: string): Promise<void> {
      const body = { session_id: providerSessionId, reason: 'USER_CLOSED' };
      await call('POST', '/v1/sessions/stop', z.unknown(), body);
    },

    /** 会话详情（状态、时长）；字段以 LiveAvatar 返回为准，结算时再取需要的部分 */
    async getSession(providerSessionId: string): Promise<Record<string, unknown>> {
      return call(
        'GET',
        `/v1/sessions/${id(providerSessionId)}`,
        z.record(z.string(), z.unknown()),
      );
    },
  };
}

export type LiveAvatarClient = ReturnType<typeof createLiveAvatarClient>;
