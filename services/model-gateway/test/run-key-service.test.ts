import { HttpError } from '@oasis/service-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRunKeyService } from '../src/service/run-key-service.ts';
import { memoryRunKeys } from './avatar-fakes.ts';

const PAYER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const RUN = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const OTHER_RUN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CONVERSATION = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b';

let clock = new Date('2026-10-22T10:00:00Z');
let repo: ReturnType<typeof memoryRunKeys>;
let service: ReturnType<typeof createRunKeyService>;
beforeEach(() => {
  clock = new Date('2026-10-22T10:00:00Z');
  repo = memoryRunKeys();
  service = createRunKeyService({ repo, now: () => clock, pollMs: 5 });
});

describe('运行临时 Key', () => {
  it('签发的 Key 能换出付费人和归属；库里只存哈希', async () => {
    const issued = await service.issue({
      payerId: PAYER,
      runId: RUN,
      conversationId: CONVERSATION,
      ttlSeconds: 60,
    });
    expect(issued.key).toMatch(/^oasis_run_[\w-]{40,}$/);
    expect(repo.rows[0]?.keyHash).not.toContain(issued.key);
    await expect(service.authenticate(`Bearer ${issued.key}`)).resolves.toEqual({
      payerId: PAYER,
      runId: RUN,
      conversationId: CONVERSATION,
    });
    // 打开了「只用国内模型」、花钱的工具要先问、关了联网搜索的一轮：凭证带着这些设置
    const scoped = await service.issue({
      payerId: PAYER,
      runId: RUN,
      domesticOnly: true,
      askPaid: true,
      noWeb: true,
      ttlSeconds: 60,
    });
    await expect(service.authenticate(`Bearer ${scoped.key}`)).resolves.toEqual({
      payerId: PAYER,
      runId: RUN,
      domesticOnly: true,
      askPaid: true,
      noWeb: true,
    });
  });

  it('作废、过期、格式不对、没带 Key 都是 401', async () => {
    const a = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
    await service.revoke(a.keyId);
    await service.revoke(a.keyId); // 幂等
    const b = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
    clock = new Date(clock.getTime() + 61_000);
    for (const header of [`Bearer ${a.key}`, `Bearer ${b.key}`, 'Bearer sk-or-xxx', undefined]) {
      const err = await service.authenticate(header).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(401);
    }
  });
});

it('运行可跨凭证租约续期；已撤销或已过期的凭证不能复活', async () => {
  const active = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
  clock = new Date(clock.getTime() + 50_000);
  await service.renew(active.keyId, 60);
  clock = new Date(clock.getTime() + 50_000);
  await expect(service.authenticate('Bearer ' + active.key)).resolves.toMatchObject({ runId: RUN });
  await service.revoke(active.keyId);
  await expect(service.renew(active.keyId, 60)).rejects.toMatchObject({
    code: 'run_key_not_active',
  });
  const expired = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 1 });
  clock = new Date(clock.getTime() + 2000);
  await expect(service.renew(expired.keyId, 60)).rejects.toMatchObject({
    code: 'run_key_not_active',
  });
});

it('同一个 dsh 接着做下一轮：Key 改归到新的一轮，「以后都允许」留着；作废了的不能改', async () => {
  const NEXT = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
  const issued = await service.issue({ payerId: PAYER, runId: RUN, ttlSeconds: 60 });
  const card = await service.ask(await service.authenticate(`Bearer ${issued.key}`), '装依赖');
  await service.decide(card.id, RUN, 'always');
  clock = new Date(clock.getTime() + 50_000);
  await service.rebind(issued.keyId, { runId: NEXT, askPaid: true, ttlSeconds: 60 });
  clock = new Date(clock.getTime() + 50_000);
  await expect(service.authenticate(`Bearer ${issued.key}`)).resolves.toMatchObject({
    runId: NEXT,
    askPaid: true,
    autoAllow: ['command'],
  });
  await service.revoke(issued.keyId);
  await expect(service.rebind(issued.keyId, { runId: RUN, ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'run_key_not_active',
  });
});

describe('确认卡', () => {
  const caller = async (askPaid = false) => {
    const { key } = await service.issue({
      payerId: PAYER,
      runId: RUN,
      conversationId: CONVERSATION,
      askPaid,
      ttlSeconds: 60,
    });
    return () => service.authenticate(`Bearer ${key}`);
  };

  it('AI 要做超出权限的事：登记、等结果、用户允许一次；别的轮看不到这张卡', async () => {
    const me = await caller();
    const card = await service.ask(await me(), '需要「完全访问」：写项目外的文件', 'call-3');
    expect(card).toMatchObject({ kind: 'command', status: 'pending', callId: 'call-3' });
    expect(await service.pending(RUN)).toHaveLength(1);
    // 用户还没点：等到时候照实回「待定」
    await expect(service.wait(await me(), card.id, 20)).resolves.toMatchObject({
      status: 'pending',
    });
    const waiting = service.wait(await me(), card.id, 5_000);
    await service.decide(card.id, RUN, 'once');
    await expect(waiting).resolves.toMatchObject({ status: 'allowed' });
    expect(await service.pending(RUN)).toEqual([]);
    await expect(service.decide(card.id, OTHER_RUN, 'deny')).rejects.toMatchObject({
      code: 'confirmation_not_found',
    });
  });

  it('以后都允许：这一轮还在等的同类卡一起允许，之后同类的不再问；拒绝、收回、作废照实记', async () => {
    const me = await caller();
    const first = await service.ask(await me(), '写项目外的文件 A');
    const second = await service.ask(await me(), '写项目外的文件 B');
    await service.decide(first.id, RUN, 'always');
    expect((await me()).autoAllow).toEqual(['command']);
    await expect(service.wait(await me(), second.id, 0)).resolves.toMatchObject({
      status: 'allowed',
    });
    await expect(service.ask(await me(), '写项目外的文件 C')).resolves.toMatchObject({
      status: 'allowed',
    });

    const other = await caller();
    repo.rows.forEach((row) => (row.autoAllow = []));
    const denied = await service.ask(await other(), '删掉系统文件夹');
    await expect(service.decide(denied.id, RUN, 'deny')).resolves.toMatchObject({
      status: 'denied',
    });
    // 已经有结果的卡再点不改
    await expect(service.decide(denied.id, RUN, 'once')).resolves.toMatchObject({
      status: 'denied',
    });
    const withdrawn = await service.ask(await other(), '装全局软件');
    await expect(service.withdraw(await other(), withdrawn.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
    const open = await service.ask(await other(), '改注册表');
    await service.revoke(repo.rows.at(-1)!.id);
    expect(repo.confirmations.find((c) => c.id === open.id)?.status).toBe('cancelled');
  });

  it('花钱的工具设了「问我」：同样内容只登记一张；允许后用掉，一张只能用一次；拒绝的不能调', async () => {
    expect(
      await service.paidTool(await (await caller())(), '生成图片，最多 $0.20'),
    ).toBeUndefined();
    const me = await caller(true);
    const card = await service.paidTool(await me(), '生成图片（m），最多 $0.20');
    expect(card).toBeDefined();
    // AI 等不及、回头重跑同一条命令：还是这一张
    await expect(service.paidTool(await me(), '生成图片（m），最多 $0.20')).resolves.toEqual(card);
    await service.decide(card!.id, RUN, 'once');
    await expect(service.paidTool(await me(), 'x', card!.id)).resolves.toBeUndefined();
    await expect(service.paidTool(await me(), 'x', card!.id)).rejects.toMatchObject({
      code: 'confirmation_not_allowed',
    });
    // 同样内容的旧卡已经用掉：再要就是新的一张
    const again = await service.paidTool(await me(), '生成图片（m），最多 $0.20');
    expect(again?.id).not.toBe(card!.id);
    await service.decide(again!.id, RUN, 'deny');
    await expect(service.paidTool(await me(), 'x', again!.id)).rejects.toMatchObject({
      code: 'confirmation_not_allowed',
    });
    // 命令的确认卡不能拿来调工具
    const command = await service.ask(await me(), '写项目外的文件');
    await service.decide(command.id, RUN, 'once');
    await expect(service.paidTool(await me(), 'x', command.id)).rejects.toMatchObject({
      code: 'confirmation_not_allowed',
    });
    // 以后都允许：这一轮里不再问
    const third = await service.paidTool(await me(), '生成视频（v），最多 $0.80');
    await service.decide(third!.id, RUN, 'always');
    await expect(service.paidTool(await me(), '生成音乐，最多 $0.10')).resolves.toBeUndefined();
  });

  it('删对话：这个对话各轮的确认卡都删掉', async () => {
    const me = await caller();
    await service.ask(await me(), '写项目外的文件');
    await service.purgeConversation(CONVERSATION);
    expect(repo.confirmations).toEqual([]);
  });
});
