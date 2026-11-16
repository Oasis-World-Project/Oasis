// 好友：申请、同意、拒绝和撤回、上限；好友之间的私聊；群主直接拉好友进群。真实数据库 + 假的账号资料。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFriendRepo } from '../src/repo/friend-repo.ts';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createFriendService } from '../src/service/friend-service.ts';
import {
  befriend,
  fakeProfiles,
  groupFiles,
  humanGroups,
  nameOf,
  NEW_GROUP,
} from './support/group-fixture.ts';
import { scratchSchema } from './support/schema.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('好友、好友之间的私聊、拉好友进群', () => {
  const { pool, create, drop } = scratchSchema('friends_test');
  const ghost = randomUUID();
  const profiles = fakeProfiles(new Map(), new Set([ghost]));
  const repo = createFriendRepo(pool, { friends: 500, pending: 50 });
  const friends = createFriendService({ repo, profiles, files: groupFiles(pool) });
  const groups = humanGroups(pool, 30);
  const people = (count: number) => Array.from({ length: count }, () => randomUUID());
  const count = async (sql: string, args: unknown[]) =>
    (await pool.query<{ n: number }>(`select count(*)::int n from ${sql}`, args)).rows[0]!.n;
  beforeAll(create);
  afterAll(drop);

  it('加好友：申请带一句验证消息，对方同意后成为好友；互相申请直接成；不能加自己和不存在的人', async () => {
    const [a, b, c] = people(3) as [string, string, string];
    expect(await friends.request(a, b, '我是阿凯', 'r')).toEqual({ status: 'requested' });
    // 再申请一次只换验证消息
    await friends.request(a, b, '周五见过', 'r');
    const { incoming } = await friends.list(b, 'r');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ message: '周五见过', profile: { id: a, name: nameOf(a) } });
    expect((await friends.list(a, 'r')).outgoing[0]).toMatchObject({ profile: { id: b } });
    // 只有收到申请的人能同意
    await expect(friends.accept(a, incoming[0]!.id)).rejects.toMatchObject({
      code: 'friend_request_not_found',
    });
    await friends.accept(b, incoming[0]!.id);
    const mine = await friends.list(a, 'r');
    expect(mine.friends.map((friend) => friend.profile.id)).toEqual([b]);
    expect(mine.friends[0]?.chatId).toBeNull();
    expect(mine.outgoing).toEqual([]);
    await expect(friends.request(a, b, '', 'r')).rejects.toMatchObject({ code: 'already_friends' });
    // 两个人互相申请：后申请的那一下直接成为好友，申请都删掉
    await friends.request(a, c, '', 'r');
    expect(await friends.request(c, a, '', 'r')).toEqual({ status: 'friends' });
    expect(await count('friend_requests where from_id in ($1,$2)', [a, c])).toBe(0);
    await expect(friends.request(a, a, '', 'r')).rejects.toMatchObject({ code: 'friend_self' });
    await expect(friends.request(a, ghost, '', 'r')).rejects.toMatchObject({
      code: 'user_not_found',
    });
  });

  it('拒绝和撤回都是真删除；好友数和没回的申请数有上限', async () => {
    const [a, b, c, d] = people(4) as [string, string, string, string];
    const strict = createFriendRepo(pool, { friends: 2, pending: 2 });
    await strict.request(a, b, '');
    await strict.request(a, c, '');
    await expect(strict.request(a, d, '')).rejects.toMatchObject({ code: 'friend_request_limit' });
    const [toB] = await strict.requests(b);
    // 不相干的人删不了
    await expect(strict.dropRequest(d, toB!.id)).rejects.toMatchObject({ statusCode: 404 });
    await strict.dropRequest(b, toB!.id); // b 拒绝
    const [toC] = await strict.requests(a);
    await strict.dropRequest(a, toC!.id); // a 撤回
    expect(await count('friend_requests where from_id=$1', [a])).toBe(0);
    await befriend(pool, a, b);
    await befriend(pool, a, c);
    await expect(strict.request(a, d, '')).rejects.toMatchObject({ code: 'friend_limit' });
    // 自己满了，别人的申请也同意不了
    await strict.request(d, a, '');
    const [fromD] = await strict.requests(d);
    await expect(strict.accept(a, fromD!.id)).rejects.toMatchObject({ code: 'friend_limit' });
  });

  it('好友之间的私聊：只有好友能开，一对好友只有一个；读和发走群的那一套，群才有的操作做不了；删好友连私聊一起删', async () => {
    const [a, b, c] = people(3) as [string, string, string];
    await expect(friends.openChat(a, b, 'r')).rejects.toMatchObject({ code: 'not_friends' });
    await befriend(pool, a, b);
    const { id } = await friends.openChat(a, b, 'r');
    expect((await friends.openChat(b, a, 'r')).id).toBe(id);
    const room = await groups.send(a, id, '在吗', randomUUID(), []);
    expect(room).toMatchObject({ kind: 'direct', memberCount: 2, ais: [] });
    expect(
      (await groups.get(b, id)).messages.map((message) => [message.displayName, message.content]),
    ).toEqual([[nameOf(a), '在吗']]);
    expect((await friends.list(b, 'r')).friends[0]).toMatchObject({ chatId: id });
    // 不算群：不在群列表里，别人读不了，改设置、拉人、踢人、设群昵称、解散都做不了
    expect(await groups.list(a)).toEqual([]);
    await befriend(pool, a, c);
    for (const attempt of [
      () => groups.get(c, id),
      () => groups.setOptions(a, id, { light: 'mint' }),
      () => groups.addMember(a, id, c, 'r'),
      () => groups.remove(a, id, b),
      () => groups.setNickname(a, id, '小甲'),
      () => groups.destroy(a, id, 'r'),
    ])
      await expect(attempt()).rejects.toMatchObject({ statusCode: 404 });
    await friends.unfriend(b, a, 'r');
    await expect(groups.get(a, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await count('messages where conversation_id=$1', [id])).toBe(0);
    await expect(friends.unfriend(a, b, 'r')).rejects.toMatchObject({ code: 'friend_not_found' });
  });

  it('群主直接拉好友进群：不是好友拉不了，群员不能拉；建群时可以一起拉；群昵称只改自己的', async () => {
    const [boss, friend, stranger] = [randomUUID(), randomUUID(), randomUUID()];
    const group = await groups.create(boss, { title: '拉人测试', ...NEW_GROUP }, 'r');
    await expect(groups.addMember(boss, group.id, friend, 'r')).rejects.toMatchObject({
      code: 'not_friends',
    });
    await befriend(pool, boss, friend);
    const pulled = await groups.addMember(boss, group.id, friend, 'r');
    expect(pulled.members.map((item) => item.displayName)).toEqual([nameOf(boss), nameOf(friend)]);
    // 头像的版本从账号资料来
    expect(pulled.members[1]).toMatchObject({ nickname: '', avatarVersion: 3 });
    // 已经在群里：再拉一次什么都不变
    expect((await groups.addMember(boss, group.id, friend, 'r')).memberCount).toBe(2);
    await befriend(pool, friend, stranger);
    await expect(groups.addMember(friend, group.id, stranger, 'r')).rejects.toMatchObject({
      code: 'owner_required',
    });
    const renamed = await groups.setNickname(friend, group.id, '小乙');
    expect(renamed.members[1]).toMatchObject({ displayName: '小乙', nickname: '小乙' });
    await groups.send(friend, group.id, '到了', randomUUID(), []);
    expect((await groups.get(boss, group.id)).messages.at(-1)?.displayName).toBe('小乙');
    // 去掉群昵称：之前说的话也跟着显示账号的名字
    await groups.setNickname(friend, group.id, '');
    expect((await groups.get(boss, group.id)).messages.at(-1)?.displayName).toBe(nameOf(friend));
    // 账号改了名字：群里记着的名字跟着改
    await createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute: 30, ais: 8 }).syncName(
      friend,
      '阿乙',
    );
    expect((await groups.get(boss, group.id)).members[1]?.displayName).toBe('阿乙');
    await befriend(pool, boss, stranger);
    const together = await groups.create(
      boss,
      { title: '一起拉', ...NEW_GROUP, members: [friend, stranger] },
      'r',
    );
    // 群主在前，一起拉的好友按拉的先后
    expect(together.members.map((item) => item.userId)).toEqual([boss, friend, stranger]);
    await expect(
      groups.create(boss, { title: '陌生人', ...NEW_GROUP, members: [randomUUID()] }, 'r'),
    ).rejects.toMatchObject({ code: 'not_friends' });
  });
});
