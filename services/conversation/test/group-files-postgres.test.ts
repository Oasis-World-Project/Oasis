// 群文件：人发的和 AI 交的都进群文件，同一个路径只有一份、再交就是新版本；AI 开一轮时拿到别人新交的；
// 引用、删除；群主删一个任务；好友私聊里的文件只跟着消息；工作台要的消息。真实数据库 + 假 harness / agent / model-gateway / canvas。
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationRepo } from '../src/repo/conversation-repo.ts';
import { createFriendRepo } from '../src/repo/friend-repo.ts';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createGroupSeats } from '../src/repo/group-seats.ts';
import { createFriendService, type FriendService } from '../src/service/friend-service.ts';
import type { GroupFiles } from '../src/service/group-files.ts';
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
import {
  client,
  deletedUploads,
  event,
  fake,
  harnessUrl,
  othersUrl,
  until,
  uploadNames,
} from './support/turn-fixture.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('群文件', () => {
  const { pool, create, drop } = scratchSchema('group_files_test');
  const owner = randomUUID(),
    member = randomUUID();
  const store = createConversationRepo(pool);
  let turns: Turns, groups: GroupService, files: GroupFiles, friends: FriendService;
  beforeAll(async () => {
    await create();
    const harness = client('harness', harnessUrl),
      canvas = client('canvas', othersUrl),
      modelGateway = client('model-gateway', othersUrl),
      agent = client('agent', othersUrl),
      logger = pino({ level: 'silent' });
    files = groupFiles(pool, canvas);
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
    const profiles = fakeProfiles(
      new Map([
        [owner, '阿杰'],
        [member, '林夏'],
      ]),
    );
    groups = createGroupService({
      repo: createGroupRepo(pool, { members: 5, groups: 20, messagesPerMinute: 60, ais: 2 }),
      seats: createGroupSeats(pool),
      store,
      turns,
      agent,
      profiles,
      files,
      assign: groupAssign(pool, { store, turns }),
      tasks: groupTasks(pool, { store, turns }),
      speak: { nudge: () => undefined },
      purge: createPurge({ harness, modelGateway, canvas }),
      vault: fakeVault(),
      logger,
    });
    friends = createFriendService({
      repo: createFriendRepo(pool, { friends: 500, pending: 50 }),
      profiles,
      files,
    });
    await befriend(pool, owner, member);
  });
  afterAll(async () => {
    await turns.close();
    await drop();
  });

  async function setup() {
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
    return group.id;
  }
  /** 发一句话：可以 @ AI、带文件（先起好名字的上传文件 ID）、引用群文件 */
  const say = (
    who: string,
    id: string,
    content: string,
    options: { at?: string[]; attachments?: string[]; refs?: string[] } = {},
  ) =>
    groups.send(
      who,
      id,
      content,
      randomUUID(),
      (options.at ?? []).map((key) => ({ kind: 'ai' as const, key })),
      { attachments: options.attachments ?? [], refs: options.refs ?? [] },
    );
  const upload = (name: string) => {
    const id = randomUUID();
    uploadNames.set(id, name);
    return id;
  };
  const busy = async (id: string, key: string) =>
    (await groups.get(owner, id)).ais.find((item) => item.key === key)!.runId;
  /** 让这一轮说一句、交出这些文件、做完 */
  async function finish(id: string, key: string, outputs: Record<string, string>, steps = false) {
    const runId = (await busy(id, key))!;
    fake.events.set(runId, [
      ...(fake.events.get(runId) ?? []),
      ...(steps
        ? [
            event(10, 'tool_call', { callId: 's1', name: 'bash', label: '整理材料' }),
            event(11, 'tool_result', { callId: 's1', ok: true }),
          ]
        : []),
      event(12, 'assistant_text', { text: '交了' }),
    ]);
    Object.assign(fake.runs.get(runId)!, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      outputs: Object.entries(outputs).map(([path, sha]) => ({
        path,
        size: 10,
        sha256: sha.repeat(64),
      })),
    });
    await until(async () => !(await busy(id, key)));
    return runId;
  }
  /** 刚开的那一轮交给 harness 的东西 */
  const lastStart = () =>
    fake.starts.at(-1) as
      | {
          prompt: string;
          materials: { path: string; artifactId?: string; uploadId?: string; ownerId?: string }[];
        }
      | undefined;

  it('人在群里发文件：进群文件；同名再发是新版本，旧的那份从 canvas 删掉；只发文件不写字也行', async () => {
    const id = await setup();
    const first = upload('嘉宾名单.csv');
    const sent = await say(member, id, '名单在这', { attachments: [first] });
    expect(sent.messages.at(-1)).toMatchObject({
      content: '名单在这',
      data: { attachments: [{ id: first, name: '嘉宾名单.csv' }] },
    });
    const list = await files.list(owner, id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      path: '嘉宾名单.csv',
      madeBy: { kind: 'user', id: member },
      changedBy: { kind: 'user', id: member },
      runId: null,
    });
    const rev = (await groups.get(owner, id)).filesRev;
    expect(rev).toBeGreaterThan(0);
    // 成员都能读内容
    const content = await files.content(owner, id, list[0]!.id);
    expect(await new Response(content.body).text()).toBe(`uploads:${first}`);
    // 群主用同一个名字再发一份：还是一份，换成新的；被换下的从 canvas 删掉
    const second = upload('嘉宾名单.csv');
    await say(owner, id, '', { attachments: [second] });
    const again = await files.list(member, id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      id: list[0]!.id,
      madeBy: { id: member },
      changedBy: { kind: 'user', id: owner },
    });
    expect(deletedUploads).toContainEqual([first]);
    expect((await groups.get(owner, id)).filesRev).toBeGreaterThan(rev);
    // 什么都不带的空话发不出去由契约挡；不是成员读不到
    await expect(files.list(randomUUID(), id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('AI 交的文件进群文件；别的 AI 开一轮时拿到它没见过的，自己交的不再拷给自己，拿过的不重复拿', async () => {
    const id = await setup();
    await say(owner, id, '写流程', { at: ['claude'] });
    // 它是全新的席位：群文件还是空的，什么都不带
    expect(lastStart()!.materials).toEqual([]);
    const runId = await finish(id, 'claude', { '发布会流程.md': 'b' });
    const [flow] = await files.list(owner, id);
    expect(flow).toMatchObject({
      path: '发布会流程.md',
      madeBy: { kind: 'ai', id: 'claude' },
      runId,
    });
    const sheet = upload('预算.xlsx');
    await say(member, id, '按这个算预算', { at: ['glm'], attachments: [sheet] });
    const start = lastStart()!;
    expect(start.materials.map((m) => m.path).sort()).toEqual([
      'materials/group/发布会流程.md',
      'materials/group/预算.xlsx',
    ]);
    // 人传的文件带着是谁名下的（不是付费的群主）
    expect(start.materials.find((m) => m.uploadId)).toMatchObject({
      uploadId: sheet,
      ownerId: member,
    });
    expect(start.prompt).toContain('materials/group/发布会流程.md（DeepSeek 交的');
    expect(start.prompt).toContain('林夏 传的');
    expect(start.prompt).toContain('林夏 @DeepSeek：按这个算预算（带了群文件：预算.xlsx）');
    await finish(id, 'glm', {});
    // 再叫 claude：它自己交的流程不拷，别人传的预算要拷；再叫一次就没有新的了
    await say(owner, id, '看看预算', { at: ['claude'] });
    expect(lastStart()!.materials.map((m) => m.path)).toEqual(['materials/group/预算.xlsx']);
    await finish(id, 'claude', { '发布会流程.md': 'b' });
    await say(owner, id, '再看看', { at: ['claude'] });
    expect(lastStart()!.materials).toEqual([]);
    expect(lastStart()!.prompt).not.toContain('群文件里别人新交');
    await finish(id, 'claude', { '发布会流程.md': 'b' });
  });

  it('别的 AI 改了同一个路径：群文件换成它的版本，写着谁做的、谁改的；原来的 AI 再登记旧版不会换回去', async () => {
    const id = await setup();
    await say(owner, id, '写流程', { at: ['claude'] });
    await finish(id, 'claude', { '流程.md': 'b' });
    await say(owner, id, '改一下流程', { at: ['glm'] });
    // 原样拷到 out/ 没改内容：不算新版本
    await finish(id, 'glm', { '流程.md': 'b' });
    expect((await files.list(owner, id))[0]).toMatchObject({ changedBy: { id: 'claude' } });
    await say(owner, id, '真的改一下', { at: ['glm'] });
    // 它把改好的连目录一起照搬成 out/materials/group/流程.md：还是算 流程.md 的新版本
    const runId = await finish(id, 'glm', { 'materials/group/流程.md': 'c' });
    const [changed] = await files.list(owner, id);
    expect(changed).toMatchObject({
      madeBy: { kind: 'ai', id: 'claude' },
      changedBy: { kind: 'ai', id: 'glm' },
      runId,
    });
    expect(await files.list(owner, id)).toHaveLength(1);
    // claude 再开一轮：拿到 glm 的新版本；它工作目录里那份旧的再登记一遍，群文件不变
    await say(owner, id, '继续', { at: ['claude'] });
    expect(lastStart()!.materials.map((m) => m.path)).toEqual(['materials/group/流程.md']);
    await finish(id, 'claude', { '流程.md': 'b' });
    expect((await files.list(owner, id))[0]).toMatchObject({
      changedBy: { id: 'glm' },
      updatedAt: changed!.updatedAt,
    });
  });

  it('引用群文件：写在消息上，AI 听得到；引用不在的文件发不出去', async () => {
    const id = await setup();
    await say(member, id, '', { attachments: [upload('平面图.png')] });
    const sent = await say(owner, id, '按这张图排座位', { at: ['glm'], refs: ['平面图.png'] });
    expect(sent.messages.find((m) => m.role === 'user')).toMatchObject({
      data: { refs: [{ path: '平面图.png', name: '平面图.png' }] },
    });
    expect(lastStart()!.prompt).toContain('按这张图排座位（带了群文件：平面图.png）');
    // 只发了文件、没写字的那句它也听到了
    expect(lastStart()!.prompt).toContain('林夏：（带了群文件：平面图.png）');
    await finish(id, 'glm', {});
    await expect(say(owner, id, '看这个', { refs: ['没有.txt'] })).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });

  it('删群文件：传的人和群主可以，AI 交的只有群主可以；它还在做时不能删；群文件满了不再加', async () => {
    const id = await setup();
    const mine = upload('歌单.txt');
    await say(member, id, '', { attachments: [mine] });
    await say(owner, id, '写流程', { at: ['claude'] });
    const runId = (await busy(id, 'claude'))!;
    // 做的过程中交了一个文件：已经在群文件里，写着是这一轮交的
    fake.events.set(runId, [
      event(0, 'tool_call', { callId: 'c1', name: 'write', label: '写流程', path: 'out/流程.md' }),
      event(1, 'tool_result', { callId: 'c1', ok: true }),
    ]);
    const flow = await until(async () =>
      (await files.list(owner, id)).find((file) => file.path === '流程.md'),
    );
    expect(flow.runId).toBe(runId);
    await expect(files.remove(owner, id, flow.id, 'r')).rejects.toMatchObject({
      code: 'file_in_use',
    });
    await finish(id, 'claude', { '流程.md': 'a' });
    await expect(files.remove(member, id, flow.id, 'r')).rejects.toMatchObject({
      code: 'file_delete_not_allowed',
    });
    await files.remove(owner, id, flow.id, 'r');
    const song = (await files.list(owner, id)).find((file) => file.path === '歌单.txt')!;
    await files.remove(member, id, song.id, 'r');
    expect(deletedUploads).toContainEqual([mine]);
    expect(await files.list(owner, id)).toEqual([]);
    // 上限 5 个：第 6 个不进群文件（消息照发）
    for (let n = 1; n <= 6; n += 1)
      await say(owner, id, '', { attachments: [upload(`图${n}.png`)] });
    expect(await files.list(owner, id)).toHaveLength(5);
  });

  it('群里的任务进群主的画布；群主删任务：任务卡、它交的成果和群文件一起删，聊天留着；别人删不了，还在做时不能删', async () => {
    const id = await setup();
    await say(owner, id, '写个流程', { at: ['claude'] });
    const running = (await busy(id, 'claude'))!;
    fake.events.set(running, [
      event(0, 'tool_call', { callId: 'c1', name: 'write', label: '写流程', path: 'out/流程.md' }),
      event(1, 'tool_result', { callId: 'c1', ok: true }),
    ]);
    await until(async () => (await files.list(owner, id)).length || undefined);
    await expect(files.removeTask(owner, id, running, 'r')).rejects.toMatchObject({
      code: 'task_running',
    });
    const runId = await finish(id, 'claude', { '流程.md': 'e' });
    // 群主的画布里有它：记在做它的席位名下，带着哪个群、哪个 AI；群员的画布里没有
    const tasks = async () =>
      (await store.listTasks(owner, 50)).filter((task) => task.message.conversationId === id);
    const [task] = await tasks();
    expect(task).toMatchObject({ message: { data: { runId } }, seat: { group: '发布会' } });
    expect(task!.seat!.id).not.toBe(id);
    expect(await store.listTasks(member, 50)).toEqual([]);
    // 成果 ID 只给群主（在画布里打开）
    expect((await files.list(owner, id))[0]!.artifactId).toBeTruthy();
    expect((await files.list(member, id))[0]!.artifactId).toBeUndefined();

    await expect(files.removeTask(member, id, runId, 'r')).rejects.toMatchObject({
      code: 'task_delete_not_allowed',
    });
    const before = (await groups.get(owner, id)).messages.map((m) => m.kind);
    await files.removeTask(owner, id, runId, 'r');
    await files.removeTask(owner, id, runId, 'r');
    expect(fake.purged).toContain(`canvas-run:${runId}`);
    expect(await files.list(owner, id)).toEqual([]);
    expect(await tasks()).toEqual([]);
    expect((await groups.get(owner, id)).messages.map((m) => m.kind)).toEqual(
      before.filter((kind) => kind !== 'task'),
    );
  });

  it('工作台要的消息：动过手的那一轮里 AI 的话（带任务名）和任务卡；只聊天的那一轮不算', async () => {
    const id = await setup();
    await say(owner, id, '你好', { at: ['glm'] });
    await finish(id, 'glm', {});
    await say(owner, id, '写个流程', { at: ['claude'] });
    const runId = await finish(id, 'claude', { '流程.md': 'd' }, true);
    const { messages } = await files.work(member, id);
    expect(messages.map((m) => [m.kind, m.authorId])).toEqual([
      ['text', 'claude'],
      ['task', 'claude'],
    ]);
    expect(messages[0]).toMatchObject({ data: { runId, title: '写个流程' } });
    expect(messages[1]).toMatchObject({ data: { runId, status: 'done' } });
    await expect(files.work(randomUUID(), id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('解散群、删好友：消息带的文件从 canvas 删掉；好友私聊里的文件只跟着消息，两个人都能读', async () => {
    const id = await setup();
    const inGroup = upload('合同.pdf');
    await say(member, id, '', { attachments: [inGroup] });
    await groups.destroy(owner, id, 'r');
    expect(deletedUploads).toContainEqual([inGroup]);

    const chat = (await friends.openChat(owner, member, 'r')).id;
    const photo = upload('合照.jpg');
    const sent = await say(owner, chat, '看这张', { attachments: [photo] });
    expect(sent.messages.at(-1)).toMatchObject({ data: { attachments: [{ id: photo }] } });
    // 私聊没有群文件，也不能引用
    await expect(files.list(owner, chat)).rejects.toMatchObject({ statusCode: 404 });
    await expect(say(owner, chat, '看', { refs: ['合照.jpg'] })).rejects.toMatchObject({
      code: 'file_not_found',
    });
    const read = await files.attachment(member, chat, photo);
    expect(await new Response(read.body).text()).toBe(`uploads:${photo}`);
    await expect(files.attachment(randomUUID(), chat, photo)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(files.attachment(member, chat, randomUUID())).rejects.toMatchObject({
      code: 'file_not_found',
    });
    await friends.unfriend(member, owner, 'r');
    expect(deletedUploads).toContainEqual([photo]);
  });
});
