// 群里的 AI：@ 了谁谁开一轮（各自一个会话），忙着的排着、做完接着开，「现在告诉它」作为插话送进去，
// 停下，移出 AI 和解散群时清掉它在别的服务里的东西。真实数据库 + 假 harness / agent / model-gateway / canvas。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationRepo } from '../src/repo/conversation-repo.ts';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createGroupSeats } from '../src/repo/group-seats.ts';
import { createGroupService, type GroupService } from '../src/service/group-service.ts';
import { createPurge } from '../src/service/purge.ts';
import { createTurns, type Turns } from '../src/service/turns.ts';
import {
  befriend,
  fakeProfiles,
  fakeVault,
  groupAssign,
  groupFiles,
  groupTasks,
} from './support/group-fixture.ts';
import { client, event, fake, harnessUrl, othersUrl, until } from './support/turn-fixture.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('群里的 AI：席位和 @', () => {
  const schema = 'group_seats_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const owner = randomUUID(),
    member = randomUUID();
  const store = createConversationRepo(pool);
  let turns: Turns, groups: GroupService;
  const nudged: string[] = [];
  const vault = fakeVault();
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const root = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
    const harness = client('harness', harnessUrl),
      canvas = client('canvas', othersUrl),
      modelGateway = client('model-gateway', othersUrl),
      agent = client('agent', othersUrl),
      logger = pino({ level: 'silent' });
    turns = createTurns({
      repo: store,
      agent,
      harness,
      canvas,
      modelGateway,
      logger,
      pollMs: 20,
      spendMs: 20,
      funded: vault.funded,
    });
    groups = createGroupService({
      repo: createGroupRepo(pool, { members: 5, groups: 20, messagesPerMinute: 30, ais: 2 }),
      seats: createGroupSeats(pool),
      store,
      turns,
      agent,
      profiles: fakeProfiles(
        new Map([
          [owner, '阿杰'],
          [member, '林夏'],
        ]),
      ),
      files: groupFiles(pool),
      assign: groupAssign(pool, { store, turns }),
      tasks: groupTasks(pool, { store, turns }),
      speak: { nudge: (groupId) => void nudged.push(groupId) },
      purge: createPurge({ harness, modelGateway, canvas }),
      vault,
      logger,
    });
  });
  afterAll(async () => {
    await turns.close();
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });

  /** 群主建一个带两个 AI 的群，再拉一个成员 */
  async function setup() {
    const group = await groups.create(
      owner,
      {
        title: '发布会',
        ais: ['claude', 'glm'],
        members: [],
        light: 'mint',
        speak: 'mention',
      },
      'r',
    );
    await befriend(pool, owner, member);
    await groups.addMember(owner, group.id, member, 'r');
    return group;
  }
  const say = (who: string, id: string, content: string, ...keys: string[]) =>
    groups.send(
      who,
      id,
      content,
      randomUUID(),
      keys.map((key) => (key === 'all' ? { kind: 'all' as const } : { kind: 'ai' as const, key })),
    );
  const ai = async (id: string, key: string) =>
    (await groups.get(owner, id)).ais.find((item) => item.key === key)!;
  /** 让这一轮说一句话、做完 */
  const finish = (runId: string, text: string) => {
    fake.events.set(runId, [event(0, 'assistant_text', { text })]);
    Object.assign(fake.runs.get(runId)!, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    });
  };

  it('@ 一个 AI：它开一轮，交给它的是群里它没听过的话；它说的话写进群里；没被 @ 的不动', async () => {
    const group = await setup();
    expect(group).toMatchObject({ light: 'mint', aiCount: 2 });
    expect(group.ais.map((item) => item.key)).toEqual(['claude', 'glm']);
    await say(owner, group.id, '先随便聊一句');
    expect(fake.starts).toHaveLength(0);
    const sent = await say(owner, group.id, '预算按 60 人算', 'glm');
    expect(fake.starts).toHaveLength(1);
    const start = fake.starts[0]!;
    // 花的是群的金库（账户号是群的 ID），记在叫它的人头上；这一轮属于席位自己的会话，不是群
    expect(start).toMatchObject({ payerId: group.id, actorId: owner, scene: 'group' });
    expect(start.conversationId).not.toBe(group.id);
    expect(start.continueFrom).toBeUndefined();
    const prompt = String(start.prompt);
    expect(prompt).toContain('阿杰（群主）：先随便聊一句');
    expect(prompt).toContain('阿杰（群主） @DeepSeek：预算按 60 人算');
    expect(prompt).toContain('轮到你了：阿杰 @ 了你。');
    expect(String(start.persona)).toContain('群名：发布会');
    expect(String(start.persona)).toContain('群里的人：阿杰（群主）、林夏');
    // 群里马上有一条它正在写的消息；舞台上它在忙，是群主引来的
    expect(sent.messages.find((m) => m.role === 'assistant')).toMatchObject({
      authorId: 'glm',
      displayName: 'DeepSeek',
      status: 'streaming',
    });
    expect(await ai(group.id, 'glm')).toMatchObject({ runId: start.runId, callers: [owner] });
    expect((await ai(group.id, 'claude')).runId).toBeNull();
    // 还在写的消息每次都在 live 里；写完后凭上次的名单再给一遍最新的样子
    const live = (await groups.get(member, group.id, { after: 999 })).live;
    expect(live.map((m) => m.authorId)).toEqual(['glm']);
    finish(String(start.runId), '按 60 人重算好了');
    await until(async () => !(await ai(group.id, 'glm')).runId);
    const done = await groups.get(member, group.id, { after: 999 }, [live[0]!.id]);
    expect(done.live).toHaveLength(1);
    expect(done.live[0]).toMatchObject({ content: '按 60 人重算好了', status: 'complete' });
    expect(done.gone).toEqual([]);
    expect((await groups.get(member, group.id, { after: 999 }, [randomUUID()])).gone).toHaveLength(
      1,
    );
  });

  it('@ 全体：只挑一个先出来负责（挑不出来按进群先后），别的 AI 不因为这句话开工；成员叫的花金库的钱、记在他头上', async () => {
    const group = await setup();
    const sent = await say(member, group.id, '大家各用一句话介绍自己', 'all');
    expect(fake.starts).toHaveLength(1);
    expect(sent.messages.find((m) => m.role === 'user')).toMatchObject({
      data: { lead: 'claude' },
    });
    const start = fake.starts[0]!;
    expect(start).toMatchObject({ payerId: group.id, actorId: member, scene: 'group' });
    expect(String(start.prompt)).toContain('林夏 @全体 AI：大家各用一句话介绍自己');
    expect(String(start.prompt)).toContain(
      '轮到你了：林夏 @ 了全体 AI，判断下来你最对口，由你先出来负责（别的 AI 在等你说完）。',
    );
    expect((await ai(group.id, 'claude')).callers).toEqual([member]);
    // 先出来的说完了：另一个 AI 没有因为这句话开工；之后点名叫它，它听得到之前那句
    finish(String(start.runId), '我先来');
    await until(async () => !(await ai(group.id, 'claude')).runId);
    expect(fake.starts).toHaveLength(1);
    await say(owner, group.id, '你也说说', 'glm');
    expect(fake.starts).toHaveLength(2);
    expect(String(fake.starts[1]!.prompt)).toContain('林夏 @全体 AI：大家各用一句话介绍自己');
    expect(String(fake.starts[1]!.prompt)).toContain('轮到你了：阿杰 @ 了你。');
    // 不在群里的 AI、不在群里的人不能 @
    await expect(say(owner, group.id, '在吗', 'grok')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('忙着的 AI：@ 它的话排着，做完接着原会话开下一轮；「现在告诉它」作为插话送进去', async () => {
    const group = await setup();
    await say(owner, group.id, '写活动流程', 'claude');
    const first = String(fake.starts[0]!.runId);
    const queued = await say(member, group.id, '加一条抽奖', 'claude');
    expect(fake.starts).toHaveLength(1);
    const waiting = queued.messages.find((m) => m.content === '加一条抽奖')!;
    // 它还没看到：听到的序号在这句之前
    expect((await ai(group.id, 'claude')).heardSeq).toBeLessThan(waiting.seq);
    // 别人的话只有群主能替他「现在告诉它」
    const other = await say(owner, group.id, '顺便问下场地', 'claude');
    const mine = other.messages.find((m) => m.content === '顺便问下场地')!;
    await expect(groups.steer(member, group.id, mine.id, 'claude')).rejects.toMatchObject({
      statusCode: 403,
    });
    await groups.steer(member, group.id, waiting.id, 'claude');
    expect(fake.interjections).toHaveLength(1);
    expect(fake.interjections[0]).toMatchObject({ runId: first });
    expect(fake.interjections[0]!.text).toContain('林夏 @DeepSeek：加一条抽奖');
    expect(fake.interjections[0]!.text).toContain('林夏 让你现在就看这句话。');
    expect(fake.interjections[0]!.text).not.toContain('顺便问下场地');
    expect((await ai(group.id, 'claude')).heardSeq).toBe(waiting.seq);
    await expect(groups.steer(member, group.id, waiting.id, 'claude')).rejects.toMatchObject({
      code: 'already_heard',
    });
    // 这一轮做完：还排着的那句接着开下一轮，接着原会话
    finish(first, '流程写好了');
    await until(() => fake.starts.length === 2);
    const second = fake.starts[1]!;
    expect(second.continueFrom).toBe(first);
    expect(second.conversationId).toBe(fake.starts[0]!.conversationId);
    expect(String(second.prompt)).toContain('阿杰（群主） @DeepSeek：顺便问下场地');
    expect(String(second.prompt)).not.toContain('加一条抽奖');
    finish(String(second.runId), '场地在天台');
    await until(async () => !(await ai(group.id, 'claude')).runId);
    expect(fake.starts).toHaveLength(2);
  });

  it('停下：群主和引来这一轮的人可以；移出 AI 清它的会话、留下成果；解散群全部清掉', async () => {
    const group = await setup();
    await say(member, group.id, '做一张海报', 'claude');
    const runId = String(fake.starts[0]!.runId);
    const seatId = String(fake.starts[0]!.conversationId);
    await expect(groups.stopRun(randomUUID(), group.id, runId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await groups.stopRun(member, group.id, runId);
    expect(fake.stops).toEqual([runId]);
    // 只有群主能加减 AI、改设置；一个群最多 2 个 AI（这里的上限）
    await expect(groups.removeAi(member, group.id, 'claude', 'r')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(groups.addAi(owner, group.id, 'grok', 'r')).rejects.toMatchObject({
      code: 'group_ai_limit',
    });
    expect((await groups.setRole(owner, group.id, 'glm', '表格、预算')).ais[1]).toMatchObject({
      key: 'glm',
      role: '表格、预算',
    });
    expect((await groups.setOptions(owner, group.id, { light: 'honey' })).options).toMatchObject({
      light: 'honey',
      speak: 'mention',
    });
    await groups.removeAi(owner, group.id, 'claude', 'r');
    expect(fake.cancels).toEqual([runId]);
    expect(fake.purged).toEqual([`harness:${seatId}`, `model-gateway:${seatId}`]);
    expect((await groups.get(owner, group.id)).ais.map((item) => item.key)).toEqual(['glm']);
    await expect(say(owner, group.id, '还在吗', 'claude')).rejects.toMatchObject({
      statusCode: 400,
    });
    // 再叫回来：是同一个席位，但不记得之前的事（下一轮开新会话）
    await groups.addAi(owner, group.id, 'claude', 'r');
    await until(async () => !(await store.find(seatId))?.turn);
    fake.starts.length = 0;
    await say(owner, group.id, '重新做一张', 'claude');
    expect(fake.starts[0]).toMatchObject({ conversationId: seatId });
    expect(fake.starts[0]!.continueFrom).toBeUndefined();
    fake.purged.length = 0;
    await groups.destroy(owner, group.id, 'r');
    // 解散时金库里剩下的退回各人
    expect(vault.dissolved).toEqual([group.id]);
    expect(fake.purged.filter((item) => item.startsWith('canvas:'))).toHaveLength(2);
    expect(fake.purged).toContain(`canvas:${seatId}`);
    expect(
      (
        await pool.query('select count(*)::int n from conversations where id=$1 or parent_id=$1', [
          group.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('金库空了：叫 AI 不开一轮，它那条消息写着金库空了；成员存入后就能用；不是成员不能看、不能存', async () => {
    const group = await setup();
    vault.balances.set(group.id, 0);
    fake.starts.length = 0;
    await say(member, group.id, '排一下流程', 'claude');
    expect(fake.starts).toHaveLength(0);
    expect((await groups.get(owner, group.id)).messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'failed',
      error: '金库空了，存入后群里的 AI 才能用',
    });
    expect((await ai(group.id, 'claude')).runId).toBeNull();
    await expect(groups.vault(randomUUID(), group.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(groups.deposit(randomUUID(), group.id, 5)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await groups.deposit(member, group.id, 5_000_000)).toMatchObject({
      availableMicro: 5_000_000,
    });
    await say(member, group.id, '再排一下流程', 'claude');
    // 花金库的钱，记在叫它的成员头上
    expect(fake.starts.at(-1)).toMatchObject({ payerId: group.id, actorId: member });
  });
});
