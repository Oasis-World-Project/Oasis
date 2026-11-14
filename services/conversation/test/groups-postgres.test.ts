import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { pino } from 'pino';
import { createHttpServer } from '@oasis/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createGroupService } from '../src/service/group-service.ts';
import { createConversationRepo } from '../src/repo/conversation-repo.ts';
import { registerGroupRoutes } from '../src/api/group-routes.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('6.1 真实数据库、权限与事件连接', () => {
  const schema = 'groups_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID(),
    dm = randomUUID();
  const repo = createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute: 30 }),
    groups = createGroupService(repo);
  const app = createHttpServer({
    service: 'groups-test',
    version: 'test',
    commit: 'test',
    logger: pino({ level: 'silent' }),
    resources: [],
    isShuttingDown: () => false,
  });
  let base = '';
  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    const root = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter((file) => file.endsWith('.sql')).sort()) {
      if (file === '20261102150000_expand_groups.sql') {
        await pool.query(
          "insert into conversations(id,kind,owner_id,title,model_key) values($1,'dm',$2,'private','deepseek')",
          [dm, owner],
        );
        for (const text of ['first', 'second'])
          await pool.query(
            "insert into messages(conversation_id,author_kind,author_id,content,status) values($1,'user',$2,$3,'complete')",
            [dm, owner, text],
          );
      }
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
      if (file === '20261102150000_expand_groups.sql')
        await pool.query(
          "insert into messages(conversation_id,author_kind,author_id,content,status) values($1,'user',$2,'during-migration','complete')",
          [dm, owner],
        );
    }
    registerGroupRoutes(app, groups, 3);
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await app.close();
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });
  const headers = (id: string) => ({ 'x-oasis-user-id': id });
  async function setup() {
    const group = await groups.create(owner, '测试群', '群主');
    const ticket = await groups.invite(owner, group.id);
    await groups.redeem(member, ticket.token, '成员');
    return group;
  }
  it('旧 DM 消息回填有序，迁移期间的新消息不冲突，群不能走私聊接口', async () => {
    const rows = (
      await pool.query(
        'select content,seq::int seq from messages where conversation_id=$1 order by seq',
        [dm],
      )
    ).rows;
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[2].content).toBe('during-migration');
    const group = await setup();
    const dms = createConversationRepo(pool);
    expect(await dms.findOwned(group.id, owner)).toBeUndefined();
    expect((await dms.findOwned(dm, owner))?.kind).toBe('dm');
    await expect(groups.get(owner, dm)).rejects.toMatchObject({ statusCode: 404 });
    await expect(groups.get(member, dm)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('单次邀请并发兑换只有一人成功，明文令牌不入库，重新生成和撤销生效', async () => {
    const group = await groups.create(owner, '邀请测试', '群主');
    const invite = await groups.invite(owner, group.id);
    const attempts = await Promise.allSettled([
      groups.redeem(member, invite.token, '乙'),
      groups.redeem(outsider, invite.token, '丙'),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const stored = (
      await pool.query('select token_hash from group_invites where conversation_id=$1', [group.id])
    ).rows[0].token_hash;
    expect(stored).not.toBe(invite.token);
    const older = await groups.invite(owner, group.id);
    await groups.invite(owner, group.id);
    await expect(groups.preview(older.token)).rejects.toMatchObject({ statusCode: 410 });
    await groups.revoke(owner, group.id);
    expect(
      (
        await pool.query('select count(*)::int n from group_invites where conversation_id=$1', [
          group.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
  it('入群显式确认历史、到期拒绝，成员不能管理其他人或解散群', async () => {
    const group = await setup();
    const invite = await groups.invite(owner, group.id);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/groups/invites/redeem',
      headers: headers(outsider),
      payload: { token: invite.token, displayName: '丙' },
    });
    expect(response.statusCode).toBe(400);
    await expect(groups.remove(member, group.id, owner)).rejects.toMatchObject({ statusCode: 409 });
    await expect(groups.remove(member, group.id, outsider)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(groups.invite(member, group.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(groups.destroy(member, group.id)).rejects.toMatchObject({ statusCode: 403 });
    // 过期一小时：数据库和测试机的钟差一两秒也算过期
    await pool.query(
      "update group_invites set expires_at=now()-interval '1 hour' where conversation_id=$1",
      [group.id],
    );
    await expect(groups.redeem(outsider, invite.token, '丙')).rejects.toMatchObject({
      statusCode: 410,
    });
  });
  it('消息并发排序、请求去重、重复请求冲突、前后游标和历史可见', async () => {
    const group = await setup(),
      requestId = randomUUID();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => groups.send(owner, group.id, `m${i}`, randomUUID())),
    );
    await Promise.all([
      groups.send(member, group.id, 'same', requestId),
      groups.send(member, group.id, 'same', requestId),
    ]);
    const snapshot = await groups.get(member, group.id);
    expect(snapshot.messages).toHaveLength(11);
    expect(new Set(snapshot.messages.map((message) => message.seq)).size).toBe(11);
    await expect(groups.send(member, group.id, 'different', requestId)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(
      (await groups.get(member, group.id, { after: 5 })).messages.every(
        (message) => message.seq > 5,
      ),
    ).toBe(true);
    expect(
      (await groups.get(member, group.id, { before: 5 })).messages.every(
        (message) => message.seq < 5,
      ),
    ).toBe(true);
    const invite = await groups.invite(owner, group.id);
    expect((await groups.redeem(outsider, invite.token, '丙')).messages).toHaveLength(11);
  });
  it('群人数和消息速率有界，失败不会消费邀请', async () => {
    const group = await setup();
    const invite = await groups.invite(owner, group.id);
    await groups.redeem(outsider, invite.token, '丙');
    const fourth = await groups.invite(owner, group.id);
    await expect(groups.redeem(randomUUID(), fourth.token, '丁')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await groups.preview(fourth.token)).title).toBe('测试群');
    const strict = createGroupService(
      createGroupRepo(pool, { members: 3, groups: 20, messagesPerMinute: 1 }),
    );
    await strict.send(owner, group.id, 'one', randomUUID());
    await expect(strict.send(owner, group.id, 'two', randomUUID())).rejects.toMatchObject({
      statusCode: 429,
    });
  });
  it('移除后旧 SSE 收到撤权并关闭，新的读取/发送/旧邀请码均拒绝；删除级联清理', async () => {
    const group = await setup();
    const response = await fetch(`${base}/v1/groups/${group.id}/events`, {
      headers: headers(member),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('snapshot');
    await groups.remove(owner, group.id, member);
    let text = '';
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const value = await reader.read();
      if (value.done) break;
      text += new TextDecoder().decode(value.value);
    }
    expect(text).toContain('removed');
    reader.releaseLock();
    await expect(groups.get(member, group.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(groups.send(member, group.id, 'late', randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(groups.get(outsider, group.id)).rejects.toMatchObject({ statusCode: 404 });
    await groups.send(owner, group.id, 'cleanup', randomUUID());
    await groups.invite(owner, group.id);
    await groups.destroy(owner, group.id);
    for (const table of ['messages', 'group_members', 'group_invites'])
      expect(
        (
          await pool.query(`select count(*)::int n from ${table} where conversation_id=$1`, [
            group.id,
          ])
        ).rows[0].n,
      ).toBe(0);
  });
  it('超过一页的历史按序补拉，SSE 用 Last-Event-ID 接续而不是丢掉中间消息', async () => {
    const group = await setup();
    await pool.query(
      "insert into messages(conversation_id,author_kind,author_id,content,status,kind,data) select $1,'user',$2,'history '||n,'complete','text','{\"displayName\":\"群主\"}'::jsonb from generate_series(1,120) n",
      [group.id, owner],
    );
    const tail = (await groups.get(member, group.id)).messages;
    expect(tail).toHaveLength(100);
    expect(tail[0]!.seq).toBe(21);
    const older = (await groups.get(member, group.id, { before: 21 })).messages;
    expect(older.map((message) => message.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect((await groups.get(member, group.id, { after: 0 })).messages.at(-1)!.seq).toBe(100);
    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/v1/groups/${group.id}/events`, {
        headers: { ...headers(member), 'last-event-id': '100' },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const text = new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain('id: 120');
      const event = JSON.parse(text.split('data: ')[1]!.trim());
      expect(event.snapshot.messages.map((message: { seq: number }) => message.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 101),
      );
      await reader.cancel();
    } finally {
      controller.abort();
    }
  });
  it('跨仓库实例互斥；持锁不占连接，出错保留已存消息并释放锁，租约过期可接手；跟进锁和操作锁互不挡', async () => {
    const singlePool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 1,
    });
    const single = createConversationRepo(singlePool),
      other = createConversationRepo(pool);
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let messageId = '';
    const pending = single.withLock('message', dm, async (scoped) => {
      const message = await scoped.insertMessage({
        conversationId: dm,
        authorKind: 'user',
        authorId: owner,
        content: 'saved before failure',
        status: 'complete',
      });
      messageId = message.id;
      // 持锁期间不占连接：同一个只有 1 条连接的池，锁外的查询照样能跑
      expect((await single.listMessages(dm, 100)).some((m) => m.id === message.id)).toBe(true);
      entered();
      await gate;
      throw new Error('harness failed');
    });
    const rejected = expect(pending).rejects.toThrow('harness failed');
    try {
      await ready;
      await expect(other.withLock('message', dm, async () => undefined)).rejects.toMatchObject({
        code: 'conversation_busy',
      });
      // 跟进一轮用另一把锁：用户操作拿着锁时也能跟进
      await other.withLock('follow', dm, async () => undefined);
      unblock();
      await rejected;
      expect((await other.findMessage(dm, messageId))?.content).toBe('saved before failure');
      await other.withLock('message', dm, async (scoped) => {
        expect(await scoped.findOwned(dm, owner)).toBeDefined();
        // 同一个实例里嵌套拿同一把锁不会自己挡自己
        await scoped.withLock('message', dm, async () => undefined);
      });
      // 持锁的进程崩了：租约过期后别的实例能接手
      await pool.query(
        "insert into conversation_locks(key,holder,expires_at) values($1,$2,now() - interval '1 second')",
        [`message:${dm}`, randomUUID()],
      );
      await other.withLock('message', dm, async () => undefined);
      expect(
        (
          await pool.query('select count(*)::int n from conversation_locks where key=$1', [
            `message:${dm}`,
          ])
        ).rows[0].n,
      ).toBe(0);
      await pool.query('delete from messages where id=$1', [messageId]);
    } finally {
      unblock();
      await pending.catch(() => {});
      await singlePool.end();
    }
  });

  it('一轮的记录：没有正在进行的一轮才能开；只改这一轮；结束后记下下一轮接着哪一轮；开新话题清掉', async () => {
    const store = createConversationRepo(pool);
    const conversation = await store.upsertDm(owner, 'turn-test', 'turns');
    const [r1, r2] = [randomUUID(), randomUUID()];
    const turn = {
      runId: r1,
      startedAt: new Date().toISOString(),
      title: '做一个网页',
      cursor: -1,
      segmentId: randomUUID(),
    };
    expect(await store.startTurn(conversation.id, turn)).toBe(true);
    expect(await store.startTurn(conversation.id, { ...turn, runId: r2 })).toBe(false);
    expect((await store.activeTurns()).map((c) => c.id)).toContain(conversation.id);
    // 只改给的字段；不是这一轮不改
    expect(await store.updateTurn(conversation.id, r1, { cursor: 7 })).toBe(true);
    expect(await store.updateTurn(conversation.id, r2, { cursor: 99 })).toBe(false);
    const segmentId = randomUUID();
    expect(
      await store.updateTurn(conversation.id, r1, { segmentId, delivering: ['out/a.png'] }),
    ).toBe(true);
    let row = await store.find(conversation.id);
    expect(row?.turn).toEqual({ ...turn, cursor: 7, segmentId, delivering: ['out/a.png'] });
    await store.endTurn(conversation.id, r2, r2);
    expect((await store.find(conversation.id))?.turn).not.toBeNull();
    await store.endTurn(conversation.id, r1, r1);
    row = await store.find(conversation.id);
    expect(row).toMatchObject({ turn: null, lastRunId: r1 });
    expect((await store.activeTurns()).map((c) => c.id)).not.toContain(conversation.id);
    expect(await store.startTurn(conversation.id, { ...turn, runId: r2 })).toBe(true);
    await store.endTurn(conversation.id, r2, r2);
    expect(await store.find(conversation.id)).toMatchObject({ lastRunId: r2 });
    await store.newTopic(conversation.id);
    expect(await store.find(conversation.id)).toMatchObject({ lastRunId: null });
    // 画布按任务分：这个人私聊里的任务卡；消息列最近的几条
    await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: 'turn-test',
      content: '任务结束',
      status: 'complete',
      kind: 'task',
      data: { runId: r1 },
    });
    expect((await store.listTasks(owner, 10)).map((m) => m.data.runId)).toEqual([r1]);
    expect(await store.listTasks(randomUUID(), 10)).toEqual([]);
    expect((await store.listMessages(conversation.id, 1)).map((m) => m.content)).toEqual([
      '任务结束',
    ]);
    // 收尾时用户发来、还没交给 AI 的话
    const pendingUser = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '再加一句',
      status: 'complete',
      data: { pending: true },
    });
    await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '已交给 AI 的',
      status: 'complete',
      data: { runId: r2 },
    });
    const pendingIds = async () => (await store.pendingMessages(conversation.id)).map((m) => m.id);
    expect(await pendingIds()).toEqual([pendingUser.id]);
    // 排着队的话交给 AI 时挪到最后
    await store.moveToEnd(conversation.id, pendingUser.id);
    expect((await store.listMessages(conversation.id, 1))[0]?.id).toBe(pendingUser.id);
    // 新的消息种类：开新话题的分隔；改消息、删消息
    const divider = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '开了新话题',
      status: 'complete',
      kind: 'topic',
      data: {},
    });
    expect(await store.updateMessage(divider.id, { content: 'x' })).toMatchObject({
      content: 'x',
    });
    await store.deleteMessage(divider.id);
    expect(await store.updateMessage(divider.id, { content: 'y' })).toBeUndefined();
    await store.deleteConversation(conversation.id);
  });

  it('删除私聊：列出全部附件，整段对话连消息一起真删除；再点开是全新的私聊', async () => {
    const store = createConversationRepo(pool);
    const conversation = await store.upsertDm(owner, 'delete-dm-test', 'to delete');
    const file = (id: string) => ({ id, name: `${id}.png`, size: 3, contentType: 'image/png' });
    const [a, b] = [randomUUID(), randomUUID()];
    await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '两张图',
      status: 'complete',
      data: { attachments: [file(a), file(b)] },
    });
    await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '又发一次',
      status: 'failed',
      data: { attachments: [file(a)] },
    });
    expect((await store.attachmentIds(conversation.id)).sort()).toEqual([a, b].sort());
    await store.deleteConversation(conversation.id);
    expect(await store.findOwned(conversation.id, owner)).toBeUndefined();
    expect(
      (
        await pool.query('select count(*)::int n from messages where conversation_id=$1', [
          conversation.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    const fresh = await store.upsertDm(owner, 'delete-dm-test', 'to delete');
    expect(fresh.id).not.toBe(conversation.id);
    expect(await store.attachmentIds(fresh.id)).toEqual([]);
  });

  it('一轮的迁移可以回滚再重建：开新话题的分隔先删掉', async () => {
    const root = new URL('../migrations/', import.meta.url);
    const sql = await readFile(new URL('20261114160000_turns.sql', root), 'utf8');
    // 话题名那一列后来删掉了：回滚一轮的迁移之前先把它加回来，重建后再删
    const dropTopic = await readFile(
      new URL('20261115010000_drop_conversation_topic.sql', root),
      'utf8',
    );
    const conversation = await createConversationRepo(pool).upsertDm(owner, 'rollback', 'r');
    await pool.query(
      "insert into messages(conversation_id,author_kind,author_id,content,status,kind) values($1,'user',$2,'新话题','complete','topic')",
      [conversation.id, owner],
    );
    await pool.query(dropTopic.split('-- migrate:down')[1]!);
    await pool.query(sql.split('-- migrate:down')[1]!);
    expect(
      (
        await pool.query('select count(*)::int n from messages where conversation_id=$1', [
          conversation.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    await pool.query(dropTopic.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    expect((await createConversationRepo(pool).find(conversation.id))?.turn).toBeNull();
    await pool.query('delete from conversations where id=$1', [conversation.id]);
  });

  it('Contract 与 Expand 可依次回滚重建，原有 DM 数据不丢', async () => {
    await pool.query("delete from conversations where kind='group'");
    const root = new URL('../migrations/', import.meta.url);
    const files = [
      '20261102150000_expand_groups.sql',
      '20261102150100_backfill_message_seq.sql',
      '20261102150200_contract_message_seq.sql',
    ];
    for (const file of [...files].reverse()) {
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:down')[1]!);
    }
    expect(
      (await pool.query('select count(*)::int n from messages where conversation_id=$1', [dm]))
        .rows[0].n,
    ).toBe(3);
    for (const file of files) {
      const sql = await readFile(new URL(file, root), 'utf8');
      await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
    }
    expect(
      (
        await pool.query(
          'select seq::int seq from messages where conversation_id=$1 order by seq',
          [dm],
        )
      ).rows.map((row) => row.seq),
    ).toEqual([1, 2, 3]);
  });
});
