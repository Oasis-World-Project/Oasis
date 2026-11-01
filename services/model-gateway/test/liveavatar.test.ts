import { describe, expect, it } from 'vitest';
import { createLiveAvatarClient, LiveAvatarError } from '../src/adapters/liveavatar.ts';

type Call = { url: string; method: string; headers: Headers; body: unknown };

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (input: string, init?: RequestInit) => {
    const call = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetcher };
}

const ok = (data: unknown) => Response.json({ code: 100, data, message: 'ok' });

describe('LiveAvatar 客户端', () => {
  it('管理接口带 X-API-KEY，开始会话用会话令牌；请求体按接口字段名', async () => {
    const { calls, fetcher } = recorder((call) => {
      if (call.url.endsWith('/v1/sessions/token')) {
        return ok({ session_id: 'sess-1', session_token: 'tok-1' });
      }
      if (call.url.endsWith('/v1/sessions/start')) {
        return ok({ livekit_url: 'wss://room', livekit_client_token: 'lk-1' });
      }
      return ok({ id: 'id-1' });
    });
    const client = createLiveAvatarClient({
      baseUrl: 'https://la.test/',
      apiKey: 'la-key',
      fetcher,
    });
    await client.createSecret('oasis-avatar-x', 'oasis_run_secret');
    await client.createLlmConfiguration({
      name: 'n',
      model: 'deepseek/x',
      secretId: 'id-1',
      baseUrl: 'https://oasis-dev.test/avatar/v1',
    });
    const token = await client.createSessionToken({
      avatarId: 'a',
      contextId: 'c',
      language: 'zh',
      llmConfigurationId: 'l',
      sandbox: true,
      maxSeconds: 60,
    });
    const room = await client.startSession(token.sessionToken);

    expect(calls[0]).toMatchObject({
      url: 'https://la.test/v1/secrets',
      body: { secret_type: 'OPENAI_API_KEY', secret_name: 'oasis-avatar-x' },
    });
    expect(calls[0]?.headers.get('x-api-key')).toBe('la-key');
    expect(calls[1]).toMatchObject({
      url: 'https://la.test/v1/llm-configurations',
      body: {
        model_name: 'deepseek/x',
        secret_id: 'id-1',
        base_url: 'https://oasis-dev.test/avatar/v1',
      },
    });
    expect(calls[2]?.body).toEqual({
      mode: 'FULL',
      avatar_id: 'a',
      is_sandbox: true,
      max_session_duration: 60,
      llm_configuration_id: 'l',
      avatar_persona: { context_id: 'c', language: 'zh' },
    });
    expect(calls[3]?.headers.get('authorization')).toBe('Bearer tok-1');
    expect(calls[3]?.headers.get('x-api-key')).toBeNull();
    expect(room).toEqual({ livekitUrl: 'wss://room', livekitToken: 'lk-1' });
  });

  it('出错时报状态和说明，不带路径里的编号，也不带请求内容', async () => {
    const { fetcher } = recorder(() =>
      Response.json({ message: 'Invalid secret' }, { status: 400 }),
    );
    const client = createLiveAvatarClient({ baseUrl: 'https://la.test', apiKey: 'k', fetcher });
    const err = await client.deleteSecret('abc-123').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveAvatarError);
    expect((err as LiveAvatarError).status).toBe(400);
    expect((err as Error).message).toContain('Invalid secret');
    expect((err as Error).message).not.toContain('abc-123');
    const secretErr = await client.createSecret('n', 'oasis_run_secret').catch((e: unknown) => e);
    expect((secretErr as Error).message).not.toContain('oasis_run_secret');
  });

  it('没配 Key 时 configured 为 false', () => {
    expect(
      createLiveAvatarClient({ baseUrl: 'https://la.test', apiKey: undefined }).configured,
    ).toBe(false);
  });
});
