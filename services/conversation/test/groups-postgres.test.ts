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
    await pool.query(
      "update group_invites set expires_at=now()-interval '1 second' where conversation_id=$1",
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
  it('跨仓库实例互斥；单连接池不死锁，生成失败保留已存消息并释放锁', async () => {
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
    const pending = single.withIntakeLock(dm, async (scoped) => {
      const message = await scoped.insertMessage({
        conversationId: dm,
        authorKind: 'user',
        authorId: owner,
        content: 'saved before model failure',
        status: 'complete',
      });
      messageId = message.id;
      entered();
      await gate;
      throw new Error('model failed');
    });
    const rejected = expect(pending).rejects.toThrow('model failed');
    try {
      await ready;
      await expect(other.withIntakeLock(dm, async () => undefined)).rejects.toMatchObject({
        code: 'intake_busy',
      });
      unblock();
      await rejected;
      expect((await other.findMessage(dm, messageId))?.content).toBe('saved before model failure');
      await other.withIntakeLock(dm, async (scoped) => {
        expect(await scoped.findOwned(dm, owner)).toBeDefined();
      });
      await pool.query('delete from messages where id=$1', [messageId]);
    } finally {
      unblock();
      await pending.catch(() => {});
      await singlePool.end();
    }
  });
  it('卡片与状态原子推进，模拟中途保存失败不留孤儿卡片或错误答案', async () => {
    const repo = createConversationRepo(pool);
    const intake = await repo.createIntake({
      id: randomUUID(),
      conversationId: dm,
      request: 'test atomic save',
      materials: [],
    });
    const initial = await repo.commitIntakeReply(
      intake!.id,
      {
        conversationId: dm,
        authorKind: 'ai',
        authorId: 'deepseek',
        content: 'original questions',
        status: 'complete',
        kind: 'questions',
        data: { intakeId: intake!.id, round: 1, answers: null },
      },
      { round: 1 },
    );
    expect((await repo.findOpenIntake(dm))?.cardMessageId).toBe(initial.id);
    const before = (
      await pool.query('select count(*)::int n from messages where conversation_id=$1', [dm])
    ).rows[0].n;
    await expect(
      repo.commitIntakeReply(
        intake!.id,
        {
          conversationId: dm,
          authorKind: 'ai',
          authorId: 'deepseek',
          content: 'must roll back',
          status: 'complete',
        },
        { turns: null as never },
      ),
    ).rejects.toBeDefined();
    expect(
      (await pool.query('select count(*)::int n from messages where conversation_id=$1', [dm]))
        .rows[0].n,
    ).toBe(before);
    await expect(
      repo.saveIntakeAnswers(intake!.id, initial.id, null as never, { q1: 'a' }),
    ).rejects.toBeDefined();
    expect((await repo.findMessage(dm, initial.id))?.data.answers).toBeNull();
    await repo.withIntakeLock(dm, (scoped) =>
      scoped.saveIntakeAnswers(intake!.id, initial.id, [], { q1: 'a' }),
    );
    expect((await repo.findMessage(dm, initial.id))?.data.answers).toEqual({ q1: 'a' });
    await pool.query('delete from messages where id=$1', [initial.id]);
    await pool.query('delete from intakes where id=$1', [intake!.id]);
  });
  it('私聊删除/替换真实事务：清除草稿上下文，保留任务快照，停止与任务识别原子互斥', async () => {
    const store = createConversationRepo(pool);
    const conversation = await store.upsertDm(owner, 'chat-actions-test', 'actions');
    const user = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '旧聊天正文',
      status: 'complete',
      data: { intent: 'chat' },
    });
    const reply = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: 'test',
      content: '旧回答',
      status: 'complete',
      data: { replyTo: user.id },
    });
    const draft = await store.createIntake({
      id: randomUUID(),
      conversationId: conversation.id,
      request: '任务原话',
      materials: [],
    });
    await store.setContextSummary(conversation.id, { throughSeq: reply.seq, text: '旧摘要' });
    await store.mutateChat(conversation.id, [user, reply], {
      id: user.id,
      content: '新聊天正文',
      replyId: reply.id,
    });
    expect((await store.findMessage(conversation.id, reply.id))?.content).toBe('');
    // 改掉的消息已压进摘要：摘要作废
    expect((await store.findOwned(conversation.id, owner))?.contextSummary).toBeNull();
    await store.updateIntake(draft!.id, { status: 'confirmed' });
    const source = await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: owner,
      content: '任务原话',
      status: 'complete',
    });
    expect(await store.taskSourceIds(conversation.id)).toContain(source.id);
    expect(await store.requestStop(conversation.id, user.id)).toBe(true);
    expect(await store.mergeMessageData(user.id, { intent: 'task' }, true)).toBeUndefined();
    await store.mergeMessageData(source.id, { intent: 'task' });
    expect(await store.requestStop(conversation.id, source.id)).toBe(false);
    await store.mutateChat(conversation.id, [user, reply]);
    expect((await store.listMessages(conversation.id, 500)).map((m) => m.id)).toEqual([source.id]);
    await pool.query('delete from intakes where conversation_id=$1', [conversation.id]);
    await pool.query('delete from messages where conversation_id=$1', [conversation.id]);
    await pool.query('delete from conversations where id=$1', [conversation.id]);
  });

  it('删除私聊：列出全部附件、认出已交付的任务，整段对话连消息和接需求记录一起真删除', async () => {
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
    const taskId = randomUUID();
    await store.insertMessage({
      conversationId: conversation.id,
      authorKind: 'ai',
      authorId: 'test',
      content: '交付了',
      status: 'complete',
      kind: 'delivery',
      data: { taskId },
    });
    await store.createIntake({
      id: randomUUID(),
      conversationId: conversation.id,
      request: '做个海报',
      materials: [],
    });
    expect((await store.attachmentIds(conversation.id)).sort()).toEqual([a, b].sort());
    expect(await store.hasDelivery(conversation.id, taskId)).toBe(true);
    expect(await store.hasDelivery(conversation.id, randomUUID())).toBe(false);
    await store.deleteConversation(conversation.id);
    expect(await store.findOwned(conversation.id, owner)).toBeUndefined();
    const left = await pool.query(
      `select (select count(*)::int from messages where conversation_id=$1) messages,
              (select count(*)::int from intakes where conversation_id=$1) intakes`,
      [conversation.id],
    );
    expect(left.rows[0]).toEqual({ messages: 0, intakes: 0 });
    // 再点开这个 AI 是全新的私聊
    const fresh = await store.upsertDm(owner, 'delete-dm-test', 'to delete');
    expect(fresh.id).not.toBe(conversation.id);
    expect(await store.attachmentIds(fresh.id)).toEqual([]);
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
