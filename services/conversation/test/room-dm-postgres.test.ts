// 和 AI 的私聊在网页上和群是同一页：读消息、连推送用群的那一套接口。真实数据库。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanGroups, nameOf } from './support/group-fixture.ts';
import { scratchSchema } from './support/schema.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('和 AI 的私聊当成一个房间来读', () => {
  const { pool, create, drop } = scratchSchema('room_dm_test');
  const groups = humanGroups(pool, 30);
  const owner = randomUUID(),
    stranger = randomUUID(),
    dm = randomUUID();
  beforeAll(async () => {
    await create();
    await pool.query(
      "insert into conversations(id,kind,owner_id,title,model_key) values($1,'dm',$2,'DeepSeek','deepseek')",
      [dm, owner],
    );
    await pool.query(
      `insert into messages(conversation_id,author_kind,author_id,content,status)
       values($1,'user',$2,'你好','complete'),($1,'ai','deepseek','你好，我在','complete')`,
      [dm, owner],
    );
  });
  afterAll(drop);

  it('和 AI 的私聊读消息、连推送用群的这一套：成员只有主人，AI 只有它；带着在哪干活、等点的确认卡、排着队的话', async () => {
    const confirmation = {
      id: randomUUID(),
      kind: 'tool',
      text: '生一张图',
      callId: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const run = randomUUID();
    await pool.query('update conversations set turn=$2 where id=$1', [
      dm,
      {
        runId: run,
        startedAt: new Date().toISOString(),
        cursor: -1,
        segmentId: randomUUID(),
        confirmations: [confirmation],
      },
    ]);
    const queued = (
      await pool.query(
        `insert into messages(conversation_id,author_kind,author_id,content,status,data)
         values($1,'user',$2,'排着的话','complete','{"pending":true}') returning id`,
        [dm, owner],
      )
    ).rows[0].id as string;
    const room = await groups.get(owner, dm);
    expect(room).toMatchObject({
      kind: 'dm',
      title: 'DeepSeek',
      ownerId: owner,
      members: [{ userId: owner, displayName: nameOf(owner), avatarVersion: 3 }],
      ais: [{ key: 'deepseek', runId: run, callers: [owner] }],
      home: { workplace: { kind: 'cloud' }, permissions: { mode: 'auto' } },
      confirmations: [{ id: confirmation.id }],
    });
    expect(
      room.messages.map((message) => [message.seq, message.displayName, message.content]),
    ).toEqual([
      [1, nameOf(owner), '你好'],
      [2, 'DeepSeek', '你好，我在'],
      [3, nameOf(owner), '排着的话'],
    ]);
    // 排着的话还在变：下一次连同最新的样子再给；删掉了（从队里拿回去改）就列在 gone 里
    expect(room.live.map((message) => message.id)).toEqual([queued]);
    await pool.query('delete from messages where id=$1', [queued]);
    const next = await groups.get(owner, dm, { after: 3 }, [queued]);
    expect(next.messages).toEqual([]);
    expect(next.gone).toEqual([queued]);
  });
  it('别人读不了、连不上；它也不能走群的接口发话', async () => {
    await expect(groups.get(stranger, dm)).rejects.toMatchObject({ statusCode: 404 });
    await expect(groups.send(owner, dm, '走群的接口发话', randomUUID(), [])).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
