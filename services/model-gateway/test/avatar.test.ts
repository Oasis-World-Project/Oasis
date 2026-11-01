import { AvatarSpec } from '@oasis/contracts/avatar';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveAvatarClient } from '../src/adapters/liveavatar.ts';
import { createAvatarService, SANDBOX_AVATAR_ID } from '../src/service/avatar-service.ts';
import { createRunKeyService } from '../src/service/run-key-service.ts';
import { fakeClient, fakeMeter, memoryRunKeys, memorySessions } from './avatar-fakes.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const OTHER = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';
const AVATAR = '9c59a215-4c9f-478f-9d95-edca74c7b0d0';
const logger = pino({ level: 'silent' });
const spec = AvatarSpec.parse({
  name: '民宿前台',
  avatarId: AVATAR,
  prompt: '你是山间民宿的前台',
  openingText: '你好，我是 AI 前台',
  maxMinutes: 3,
});

let clock: Date;
let runKeyRepo: ReturnType<typeof memoryRunKeys>;
let runKeys: ReturnType<typeof createRunKeyService>;
let sessions: ReturnType<typeof memorySessions>;
let billing: ReturnType<typeof fakeMeter>;
beforeEach(() => {
  clock = new Date('2026-11-01T12:00:00Z');
  runKeyRepo = memoryRunKeys();
  runKeys = createRunKeyService({ repo: runKeyRepo, now: () => clock });
  sessions = memorySessions(() => clock);
  billing = fakeMeter();
});

function service(
  client: LiveAvatarClient,
  options: { sandbox?: boolean; publicBaseUrl?: string } = {},
) {
  return createAvatarService({
    client,
    runKeys,
    repo: sessions,
    calls: billing.repo,
    meter: billing.meter,
    publicBaseUrl: options.publicBaseUrl ?? 'https://oasis-dev.test/avatar/v1',
    model: 'deepseek/x',
    sandbox: options.sandbox ?? false,
    creditMicro: 95_000,
    sweepMs: 60_000,
    logger,
    now: () => clock,
  });
}
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
/** 让 stop 之后放到后台的收尾跑完 */
const settleBackground = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('数字人会话', () => {
  it('按最长时长冻结，边建边记资源；结束后后台拆资源、按实际消耗的积分结算', async () => {
    const fake = fakeClient();
    const avatars = service(fake.client);
    const started = await avatars.start(PAYER, { spec });
    // 3 分钟 × 每分钟 2 积分 × $0.095
    expect(billing.holds[0]?.amountMicro).toBe(3 * 190_000);
    expect(started).toMatchObject({
      sandbox: false,
      maxSeconds: 180,
      pricePerMinuteMicro: 190_000,
    });
    expect(fake.tokens[0]).toMatchObject({ avatarId: AVATAR, sandbox: false, maxSeconds: 180 });
    const row = sessions.rows.get(started.sessionId);
    expect(row?.resources).toMatchObject({
      secretId: 'sec-1',
      llmConfigurationId: 'llm-1',
      contextId: 'ctx-1',
      providerSessionId: 'la-sess',
    });
    // 交给 LiveAvatar 的是会话专用的临时 Key
    await expect(
      runKeys.authenticate(`Bearer ${fake.secrets.get('sec-1')}`),
    ).resolves.toMatchObject({ payerId: PAYER, runId: started.sessionId });
    expect(await avatars.liveSession(started.sessionId)).toBeDefined();

    await avatars.stop(OTHER, started.sessionId); // 别人的会话：不动
    expect(sessions.rows.get(started.sessionId)?.status).toBe('live');
    later(70_000);
    fake.setSession({
      end_at: '2026-11-01T12:01:10',
      credits_consumed: 3,
      end_reason: 'USER_CLOSED',
    });
    await avatars.stop(PAYER, started.sessionId);
    await avatars.stop(PAYER, started.sessionId); // 幂等
    await settleBackground();
    await avatars.sweep();

    const ended = sessions.rows.get(started.sessionId);
    expect(ended).toMatchObject({
      status: 'ended',
      endReason: 'USER_CLOSED',
      chargedMicro: 285_000,
    });
    expect(ended?.cleanedAt).not.toBeNull();
    expect(billing.settled).toEqual([{ id: row?.callId, costMicro: 285_000, source: 'provider' }]);
    expect(fake.log.filter((x) => x.startsWith('delete')).sort()).toEqual([
      'deleteContext',
      'deleteLlmConfiguration',
      'deleteSecret',
    ]);
    expect(fake.log.filter((x) => x === 'stopSession')).toHaveLength(1);
    expect(runKeyRepo.rows[0]?.revokedAt).not.toBeNull();
    expect(await avatars.liveSession(started.sessionId)).toBeUndefined();
    await expect(avatars.view(PAYER, started.sessionId)).resolves.toMatchObject({
      status: 'ended',
      chargedMicro: 285_000,
    });
    await expect(avatars.view(OTHER, started.sessionId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('中途失败：会话记为没开成，拆掉已建的部分，冻结按 0 结算', async () => {
    const fake = fakeClient({ failAt: 'createSessionToken' });
    const avatars = service(fake.client);
    await expect(avatars.start(PAYER, { spec })).rejects.toMatchObject({
      statusCode: 502,
      code: 'avatar_provider_error',
    });
    await settleBackground();
    await avatars.sweep();
    const [row] = [...sessions.rows.values()];
    expect(row).toMatchObject({ status: 'ended', endReason: 'START_FAILED', chargedMicro: 0 });
    expect(row?.cleanedAt).not.toBeNull();
    expect(billing.settled.map((s) => s.costMicro)).toEqual([0]);
    expect(runKeyRepo.rows[0]?.revokedAt).not.toBeNull();
  });

  it('沙箱：不冻结、不收钱，用官方测试形象', async () => {
    const fake = fakeClient();
    const avatars = service(fake.client, { sandbox: true });
    const started = await avatars.start(PAYER, { spec });
    expect(started.pricePerMinuteMicro).toBe(0);
    expect(fake.tokens[0]).toMatchObject({ avatarId: SANDBOX_AVATAR_ID, sandbox: true });
    expect(billing.holds).toEqual([]);
    // 页面收到的结束事件没带原因：以 LiveAvatar 的记录为准
    fake.setSession({ end_at: '2026-11-01T12:01:00', end_reason: 'MAX_DURATION_REACHED' });
    await avatars.stop(PAYER, started.sessionId, 'UNKNOWN');
    await settleBackground();
    await avatars.sweep();
    expect(sessions.rows.get(started.sessionId)).toMatchObject({
      chargedMicro: 0,
      endReason: 'MAX_DURATION_REACHED',
    });
  });

  it('清扫：LiveAvatar 那边已结束的跟着结束；超过最长时长的强制结束；查不到消耗时过一阵按分钟估算', async () => {
    const fake = fakeClient();
    const avatars = service(fake.client);
    const a = await avatars.start(PAYER, { spec });
    later(40_000);
    fake.setSession({ end_at: '2026-11-01T12:00:40', end_reason: 'USER_DISCONNECTED' });
    await avatars.sweep();
    expect(sessions.rows.get(a.sessionId)).toMatchObject({
      status: 'ended',
      endReason: 'USER_DISCONNECTED',
      settledAt: null,
    });
    later(11 * 60_000); // 一直没报消耗：按 1 分钟估
    await avatars.sweep();
    expect(sessions.rows.get(a.sessionId)?.chargedMicro).toBe(190_000);

    fake.setSession({});
    const b = await avatars.start(PAYER, { spec });
    later(180_000 + 2 * 60_000 + 1000);
    await avatars.sweep();
    expect(sessions.rows.get(b.sessionId)).toMatchObject({
      status: 'ended',
      endReason: 'MAX_DURATION_REACHED',
    });
  });

  it('没配 Key 或没配公网入口时直接 503，不碰 LiveAvatar', async () => {
    const fake = fakeClient();
    await expect(
      service({ ...fake.client, configured: false }).start(PAYER, { spec }),
    ).rejects.toMatchObject({ code: 'avatar_not_configured' });
    await expect(
      service(fake.client, { publicBaseUrl: '' }).start(PAYER, { spec }),
    ).rejects.toMatchObject({ code: 'avatar_entry_not_configured' });
    expect(fake.log).toEqual([]);
    expect(sessions.rows.size).toBe(0);
  });
});
