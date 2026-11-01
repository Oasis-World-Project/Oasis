import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveAvatarClient } from '../src/adapters/liveavatar.ts';
import { AVATAR_COMPLETIONS_PATH, createAvatarLlmServer } from '../src/api/avatar-server.ts';
import type { NewRunKey, RunKey, RunKeysRepo } from '../src/repo/run-keys-repo.ts';
import { createAvatarService } from '../src/service/avatar-service.ts';
import { createRunKeyService } from '../src/service/run-key-service.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const OTHER = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const AVATAR = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
const logger = pino({ level: 'silent' });

function memoryRepo(): RunKeysRepo & { rows: RunKey[] } {
  const rows: RunKey[] = [];
  return {
    rows,
    async insert(key: NewRunKey) {
      rows.push({
        ...key,
        taskId: key.taskId ?? null,
        nodeId: key.nodeId ?? null,
        revokedAt: null,
        createdAt: new Date(),
      });
    },
    async findActive(keyHash, now) {
      return rows.find((r) => r.keyHash === keyHash && !r.revokedAt && r.expiresAt > now);
    },
    async revoke(id, now) {
      const row = rows.find((r) => r.id === id && !r.revokedAt);
      if (row) row.revokedAt = now;
      return Boolean(row);
    },
  };
}

/** 假的 LiveAvatar：记下每一步，能在指定步骤失败 */
function fakeClient(failAt?: string) {
  const log: string[] = [];
  const secrets = new Map<string, string>();
  const step = async <T>(name: string, value: T): Promise<T> => {
    log.push(name);
    if (name === failAt) throw new Error(`${name} failed`);
    return value;
  };
  const client = {
    configured: true,
    credits: async () => 10,
    createSecret: async (_name: string, value: string) => {
      secrets.set('sec-1', value);
      return step('createSecret', 'sec-1');
    },
    deleteSecret: async () => void (await step('deleteSecret', undefined)),
    createLlmConfiguration: async () => step('createLlmConfiguration', 'llm-1'),
    deleteLlmConfiguration: async () => void (await step('deleteLlmConfiguration', undefined)),
    createContext: async () => step('createContext', 'ctx-1'),
    deleteContext: async () => void (await step('deleteContext', undefined)),
    createSessionToken: async () =>
      step('createSessionToken', { providerSessionId: 'la-sess', sessionToken: 'tok' }),
    startSession: async () =>
      step('startSession', { livekitUrl: 'wss://room', livekitToken: 'lk' }),
    stopSession: async () => void (await step('stopSession', undefined)),
    getSession: async () => ({}),
  } satisfies LiveAvatarClient;
  return { client, log, secrets };
}

const input = {
  name: '民宿前台',
  prompt: '你是民宿前台',
  openingText: '你好，我是 AI 前台',
  avatarId: AVATAR,
  language: 'zh',
  sandbox: true,
  maxSeconds: 60,
};

let repo: ReturnType<typeof memoryRepo>;
let runKeys: ReturnType<typeof createRunKeyService>;
beforeEach(() => {
  repo = memoryRepo();
  runKeys = createRunKeyService({ repo });
});

function service(
  client: LiveAvatarClient,
  publicBaseUrl: string | undefined = 'https://oasis-dev.test/avatar/v1',
) {
  return createAvatarService({ client, runKeys, publicBaseUrl, model: 'deepseek/x', logger });
}

describe('数字人会话', () => {
  it('依次建好 Key、配置、人设、会话；结束时倒序拆掉并作废 Key', async () => {
    const fake = fakeClient();
    const avatars = service(fake.client);
    const started = await avatars.start(PAYER, input);
    expect(started).toMatchObject({
      providerSessionId: 'la-sess',
      livekitUrl: 'wss://room',
      sandbox: true,
    });
    expect(avatars.isActive(started.sessionId)).toBe(true);
    // 交给 LiveAvatar 的是会话专用的临时 Key，能换出付费人
    const caller = await runKeys.authenticate(`Bearer ${fake.secrets.get('sec-1')}`);
    expect(caller).toMatchObject({ payerId: PAYER, runId: started.sessionId });

    await avatars.stop(OTHER, started.sessionId); // 不是自己的会话：不动
    expect(avatars.isActive(started.sessionId)).toBe(true);
    await avatars.stop(PAYER, started.sessionId);
    await avatars.stop(PAYER, started.sessionId); // 幂等
    expect(fake.log).toEqual([
      'createSecret',
      'createLlmConfiguration',
      'createContext',
      'createSessionToken',
      'startSession',
      'stopSession',
      'deleteContext',
      'deleteLlmConfiguration',
      'deleteSecret',
    ]);
    expect(avatars.isActive(started.sessionId)).toBe(false);
    expect(repo.rows[0]?.revokedAt).not.toBeNull();
  });

  it('中途失败时拆掉已建好的部分，给调用方的是看得懂的错误', async () => {
    const fake = fakeClient('createSessionToken');
    const avatars = service(fake.client);
    const err = await avatars.start(PAYER, input).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502, code: 'avatar_provider_error' });
    expect(fake.log.slice(-3)).toEqual(['deleteContext', 'deleteLlmConfiguration', 'deleteSecret']);
    expect(repo.rows[0]?.revokedAt).not.toBeNull();
    expect(avatars.active()).toBe(0);
  });

  it('没配 Key 或没配公网入口时直接 503，不碰 LiveAvatar', async () => {
    const fake = fakeClient();
    await expect(
      service({ ...fake.client, configured: false }).start(PAYER, input),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'avatar_not_configured',
    });
    await expect(service(fake.client, '').start(PAYER, input)).rejects.toMatchObject({
      statusCode: 503,
      code: 'avatar_entry_not_configured',
    });
    expect(fake.log).toEqual([]);
  });
});

describe('数字人大模型入口', () => {
  it('只有一条路径；只认正在进行的数字人会话的 Key', async () => {
    const fake = fakeClient();
    const avatars = service(fake.client);
    const started = await avatars.start(PAYER, input);
    const avatarKey = fake.secrets.get('sec-1');
    const agentKey = (await runKeys.issue({ payerId: PAYER, runId: OTHER, ttlSeconds: 60 })).key;
    const seen: string[] = [];
    const app = createAvatarLlmServer({
      logger,
      runKeys,
      isActiveSession: avatars.isActive,
      completions: async (caller, _request, reply) => {
        seen.push(caller.runId ?? '');
        return reply.send({ ok: true });
      },
    });
    const post = (authorization?: string, url = AVATAR_COMPLETIONS_PATH) =>
      app.inject({
        method: 'POST',
        url,
        headers: authorization ? { authorization } : {},
        payload: { model: 'x', messages: [{ role: 'user', content: '你好' }] },
      });

    expect((await post(`Bearer ${avatarKey}`)).statusCode).toBe(200);
    expect((await post(`Bearer ${agentKey}`)).statusCode).toBe(401);
    expect((await post()).statusCode).toBe(401);
    expect((await post(`Bearer ${avatarKey}`, '/run/v1/chat/completions')).statusCode).toBe(404);
    expect((await post(`Bearer ${avatarKey}`, '/internal/v1/chat/completions')).statusCode).toBe(
      404,
    );
    await avatars.stop(PAYER, started.sessionId);
    expect((await post(`Bearer ${avatarKey}`)).statusCode).toBe(401);
    expect(seen).toEqual([started.sessionId]);
    await app.close();
  });
});
