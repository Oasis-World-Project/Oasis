// 群里的云端任务：作为任务发布的一件事有自己的会话（不占 AI 的席位），让 AI 改它交的文件就接着这份会话做、
// 算在原来那张任务卡上；停下按轮；把 AI 移出群时它做过的任务的会话一起清。
// 真实数据库 + 假 harness / agent / model-gateway / canvas。
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskCard } from '@oasis/contracts/conversation';
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
import { scratchSchema } from './support/schema.ts';
import { client, event, fake, harnessUrl, othersUrl, until } from './support/turn-fixture.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('群里的云端任务', () => {
  const { pool, create, drop } = scratchSchema('group_tasks_test');
  const owner = randomUUID(),
    member = randomUUID();
  const store = createConversationRepo(pool);
  let turns: Turns, groups: GroupService;
  beforeAll(async () => {
    await create();
    const harness = client('harness', harnessUrl),
      canvas = client('canvas', othersUrl),
      modelGateway = client('model-gateway', othersUrl),
      agent = client('agent', othersUrl),
      logger = pino({ level: 'silent' });
    const files = groupFiles(pool, canvas);
    turns = createTurns({
      repo: store,
      agent,
      harness,
      canvas,
      modelGateway,
      logger,
      pollMs: 20,
      spendMs: 20,
      delivered: files.delivered,
    });
    groups = createGroupService({
      repo: createGroupRepo(pool, { members: 5, groups: 20, messagesPerMinute: 60, ais: 2 }),
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
      files,
      assign: groupAssign(pool, { store, turns }),
      tasks: groupTasks(pool, { store, turns }),
      speak: { nudge: () => undefined },
      purge: createPurge({ harness, modelGateway, canvas }),
      vault: fakeVault(),
      logger,
    });
    await befriend(pool, owner, member);
  });
  afterAll(async () => {
    await turns.close();
    await drop();
  });

  const say = (
    who: string,
    id: string,
    content: string,
    options: { at?: string[]; refs?: string[]; task?: boolean; seat?: string } = {},
  ) =>
    groups.send(
      who,
      id,
      content,
      randomUUID(),
      (options.at ?? []).map((key) => ({ kind: 'ai' as const, key })),
      {
        attachments: [],
        refs: options.refs ?? [],
        task: options.task ?? false,
        seat: options.seat,
      },
    );
  const ai = async (id: string, key = 'claude') =>
    (await groups.get(owner, id)).ais.find((item) => item.key === key)!;
  const kindOf = async (sessionId: unknown) =>
    (await pool.query<{ kind: string }>('select kind from conversations where id=$1', [sessionId]))
      .rows[0]?.kind;
  /** 让这一轮说一句、交出这些文件、做完 */
  async function finish(runId: string, outputs: Record<string, string> = {}) {
    fake.events.set(runId, [event(12, 'assistant_text', { text: '交了' })]);
    Object.assign(fake.runs.get(runId)!, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      outputs: Object.entries(outputs).map(([path, sha]) => ({
        path,
        size: 10,
        sha256: sha.repeat(64),
      })),
    });
    await until(async () => {
      const row = await pool.query("select 1 from conversations where turn->>'runId'=$1", [runId]);
      return row.rowCount === 0;
    });
  }
  const cards = async (id: string) =>
    (await groups.get(owner, id, { after: 0 })).messages.flatMap((m) =>
      m.kind === 'task' ? [m.data as TaskCard] : [],
    );

  it('作为任务发布：开一个云端任务（自己的会话），不占席位；停下按轮；交的文件有任务卡，卡上记着是哪份会话', async () => {
    const group = await groups.create(
      owner,
      {
        title: '发布会',
        ais: ['claude', 'glm'],
        members: [member],
        light: 'mint',
        speak: 'mention',
      },
      'r',
    );
    const id = group.id;
    fake.starts.length = 0;
    await say(member, id, '做一张海报', { at: ['claude'], task: true });
    const start = fake.starts[0]!;
    const taskId = String(start.conversationId);
    expect(await kindOf(taskId)).toBe('task');
    expect(start).toMatchObject({ payerId: id, actorId: member, scene: 'group' });
    expect(String(start.prompt)).toContain(
      '轮到你了：林夏 @ 了你，这件事是作为任务发到群里的，由你负责。',
    );
    // 席位空着，任务记在它名下
    expect(await ai(id)).toMatchObject({
      runId: null,
      tasks: [{ runId: start.runId, callers: [member] }],
    });
    // 它做任务的同时 @ 它：席位照常开一轮（两份会话互不挡），这句话席位只听一次
    await say(owner, id, '顺便想个口号', { at: ['claude'] });
    expect(fake.starts).toHaveLength(2);
    const seatRun = String(fake.starts[1]!.runId);
    expect(await kindOf(fake.starts[1]!.conversationId)).toBe('seat');
    expect(String(fake.starts[1]!.prompt)).not.toContain('轮到你了：林夏');
    expect(await ai(id)).toMatchObject({ runId: seatRun, tasks: [{ runId: start.runId }] });
    await finish(seatRun);
    // 停下任务的那一轮：群主和叫它的人可以，别的成员不行
    const other = randomUUID();
    await befriend(pool, owner, other);
    await groups.addMember(owner, id, other, 'r');
    await expect(groups.stopRun(other, id, String(start.runId))).rejects.toMatchObject({
      statusCode: 403,
    });
    await groups.stopRun(member, id, String(start.runId));
    expect(fake.stops).toContain(start.runId);
    await finish(String(start.runId), { '海报.png': 'a' });
    expect((await ai(id)).tasks).toEqual([]);
    expect(await cards(id)).toMatchObject([{ runId: start.runId, status: 'done', seat: taskId }]);

    // ---- 让它改这个任务（点名这个任务的会话）：接着这份会话做，算在原来那张卡上 ----
    await say(other, id, '标题再大一点', { at: ['claude'], refs: ['海报.png'], seat: taskId });
    expect(fake.starts).toHaveLength(3);
    const again = fake.starts[2]!;
    expect(again).toMatchObject({
      conversationId: taskId,
      continueFrom: start.runId,
      actorId: other,
    });
    expect(String(again.prompt)).toContain('标题再大一点（带了群文件：海报.png）');
    expect((await ai(id)).runId).toBeNull();
    // 它还在改：再让它改先别发
    await expect(
      say(owner, id, '颜色也换一下', { at: ['claude'], seat: taskId }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'task_running' });
    await until(async () => ((await cards(id))[0]?.status === 'running' ? true : undefined));
    expect((await cards(id))[0]).toMatchObject({ revision: 1, runs: [start.runId, again.runId] });
    await finish(String(again.runId), { '海报.png': 'b' });
    expect(await cards(id)).toMatchObject([
      { status: 'done', revision: 1, runs: [start.runId, again.runId], seat: taskId },
    ]);
    // 之后 @ 它：席位听得到那句让它改的话，但不当成叫它（叫它的只有这一句的人）
    await say(owner, id, '口号定了吗', { at: ['claude'] });
    const asked = String(fake.starts[3]!.prompt);
    expect(asked).toContain('标题再大一点');
    expect(asked).toContain('轮到你了：阿杰 @ 了你。');
    await finish(String(fake.starts[3]!.runId));

    // ---- 把它移出群：它做过的任务的会话清掉、不留；任务卡还在 ----
    fake.purged.length = 0;
    await groups.removeAi(owner, id, 'claude', 'r');
    expect(fake.purged).toContain(`harness:${taskId}`);
    expect(await kindOf(taskId)).toBeUndefined();
    expect(await cards(id)).toHaveLength(1);
  });
});
