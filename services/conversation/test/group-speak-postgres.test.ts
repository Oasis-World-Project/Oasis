// 没人 @ 时谁接话：只在被 @ 时的群不判断；「看情况」里掷中的那个开一轮（先听群聊），没掷中没人开口，
// 同一句话只判断一次；「积极参与」的群安静久了、有人开着才会起话头。真实数据库 + 假 harness + 假判断模型。
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { ServiceClient } from '@oasis/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationRepo } from '../src/repo/conversation-repo.ts';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createGroupSeats } from '../src/repo/group-seats.ts';
import { createGroupTalk } from '../src/repo/group-talk.ts';
import { createGroupService, type GroupService } from '../src/service/group-service.ts';
import { createGroupSpeak, type GroupSpeak } from '../src/service/group-speak.ts';
import { createPurge } from '../src/service/purge.ts';
import { createTurns, type Turns } from '../src/service/turns.ts';
import { fakeProfiles, groupFiles } from './support/group-fixture.ts';
import { scratchSchema } from './support/schema.ts';
import { client, fake, harnessUrl, othersUrl, until } from './support/turn-fixture.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('没人 @ 时谁接话', () => {
  const { pool, create, drop } = scratchSchema('group_speak_test');
  const owner = randomUUID();
  const store = createConversationRepo(pool);
  /** 假判断模型：每个 AI 有多少值得说的由测试摆好；记下问了几次、问的什么 */
  const judge = { relevance: {} as Record<string, number>, asked: [] as string[] };
  let roll = 0;
  let clock = Date.now();
  let watched = true;
  let turns: Turns, groups: GroupService, speak: GroupSpeak;
  beforeAll(async () => {
    await create();
    const harness = client('harness', harnessUrl),
      canvas = client('canvas', othersUrl),
      modelGateway = client('model-gateway', othersUrl),
      agent = client('agent', othersUrl),
      logger = pino({ level: 'silent' });
    const seats = createGroupSeats(pool);
    turns = createTurns({ repo: store, agent, harness, canvas, modelGateway, logger, pollMs: 20 });
    speak = createGroupSpeak({
      talk: createGroupTalk(pool),
      seats,
      store,
      turns,
      agent,
      modelGateway: {
        json: async (
          _method: string,
          _path: string,
          options: { body: { messages: { content: string }[] } },
        ) => {
          judge.asked.push(options.body.messages[1]!.content);
          const ais = Object.fromEntries(
            Object.entries(judge.relevance).map(([key, relevance]) => [
              key,
              { relevance, warmth: 1 },
            ]),
          );
          return { choices: [{ message: { content: JSON.stringify({ depth: 0.5, ais }) } }] };
        },
      } as unknown as ServiceClient,
      logger,
      files: groupFiles(pool),
      model: 'fast',
      quietMs: 0,
      watched: () => watched,
      random: () => roll,
      now: () => clock,
    });
    groups = createGroupService({
      repo: createGroupRepo(pool, { members: 5, groups: 20, messagesPerMinute: 30, ais: 2 }),
      seats,
      store,
      turns,
      agent,
      profiles: fakeProfiles(new Map([[owner, '阿杰']])),
      files: groupFiles(pool),
      speak,
      purge: createPurge({ harness, modelGateway, canvas }),
      logger,
    });
  });
  afterAll(async () => {
    speak.close();
    await turns.close();
    await drop();
  });

  const setup = async (speakMode: 'mention' | 'auto' | 'active') => {
    fake.starts.length = 0;
    judge.asked.length = 0;
    return groups.create(
      owner,
      {
        title: '发布会',
        ais: ['claude', 'glm'],
        members: [],
        light: 'mint',
        speak: speakMode,
        assign: 'ai',
      },
      'r',
    );
  };
  const say = (id: string, content: string) => groups.send(owner, id, content, randomUUID(), []);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('「只在被 @ 时」的群不判断，也没人开口', async () => {
    const group = await setup('mention');
    await say(group.id, '预算大概多少');
    await settled();
    expect(judge.asked).toEqual([]);
    expect(fake.starts).toEqual([]);
  });

  it('「看情况」：掷中的那个开一轮，先听群聊、知道没人 @ 它；同一句话只判断一次；没掷中没人开口', async () => {
    const group = await setup('auto');
    judge.relevance = { claude: 1, glm: 0 };
    roll = 0.4; // claude 的概率是 (0.15 + 0.1) × 2 × 1 = 0.5，glm 是 0
    await say(group.id, '预算大概多少');
    await until(() => fake.starts.length === 1);
    expect(judge.asked).toHaveLength(1);
    expect(judge.asked[0]).toContain('key=claude');
    expect(judge.asked[0]).toContain('阿杰：预算大概多少');
    expect(judge.asked[0]).toContain('最后已经连着 0 句是 AI 说的');
    const prompt = String(fake.starts[0]!.prompt);
    expect(prompt).toContain('阿杰（群主）：预算大概多少');
    expect(prompt).toContain('没人 @ 你');
    const seat = (await createGroupSeats(pool).list(group.id)).find(
      (item) => item.model_key === 'claude',
    )!;
    expect(fake.starts[0]).toMatchObject({ conversationId: seat.id, scene: 'group' });
    expect(Number(seat.options.warmth)).toBe(1);
    // 这句已经判断过：再看一遍不会重复问
    await speak.sweep(30_000);
    expect(judge.asked).toHaveLength(1);

    const quiet = await setup('auto');
    roll = 0.6;
    await say(quiet.id, '预算大概多少');
    await until(() => judge.asked.length === 1);
    await settled();
    expect(fake.starts).toEqual([]);
  });

  it('「积极参与」：群里安静了三分钟以上、有人开着，才可能自己起话头；「看情况」不会', async () => {
    const group = await setup('active');
    judge.relevance = { claude: 0, glm: 0 };
    roll = 0.9;
    await say(group.id, '今天先到这');
    await until(() => judge.asked.length === 1);
    roll = 0; // 一定掷中
    await speak.sweep(30_000);
    expect(fake.starts).toEqual([]); // 才刚说完
    clock = Date.now() + 10 * 60_000;
    watched = false;
    await speak.sweep(30_000);
    expect(fake.starts).toEqual([]); // 没人开着这个群
    watched = true;
    await pool.query(
      'update conversations set options=options || \'{"speak":"auto"}\' where id=$1',
      [group.id],
    );
    await speak.sweep(30_000);
    expect(fake.starts).toEqual([]);
    await pool.query(
      'update conversations set options=options || \'{"speak":"active"}\' where id=$1',
      [group.id],
    );
    await speak.sweep(30_000);
    expect(fake.starts).toHaveLength(1);
    expect(String(fake.starts[0]!.prompt)).toContain('不要自己开始做任务');
    clock = Date.now();
  });
});
