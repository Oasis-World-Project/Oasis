// 真实数据库：成果按话题登记（撤掉任务后收缩过的结构）、仓库的查询，收缩迁移的回退。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArtifactsRepo, type NewArtifact } from '../src/repo/artifacts-repo.ts';

const CONTRACT = '20261114200000_contract_conversation_artifacts.sql';

describe.skipIf(!process.env.TEST_DATABASE_URL)('成果按话题登记（真实数据库）', () => {
  const schema = 'canvas_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const repo = createArtifactsRepo(pool);
  const root = new URL('../migrations/', import.meta.url);
  const part = async (file: string, which: 'up' | 'down') => {
    const [, rest] = (await readFile(new URL(file, root), 'utf8')).split('-- migrate:up');
    const [up, down] = rest!.split('-- migrate:down');
    return which === 'up' ? up! : down!;
  };
  const owner = randomUUID(),
    other = randomUUID(),
    conversation = randomUUID(),
    s1 = randomUUID(),
    s2 = randomUUID(),
    r1 = randomUUID(),
    r2 = randomUUID();
  const row = (path: string, extra: Partial<NewArtifact> = {}): NewArtifact => ({
    id: randomUUID(),
    ownerId: owner,
    conversationId: conversation,
    sessionId: s1,
    runId: r1,
    topic: '小木屋',
    path,
    name: path.split('/').at(-1)!,
    sha256: 'a'.repeat(64),
    size: 3,
    contentType: 'text/markdown',
    category: 'doc',
    appSpec: null,
    avatarSpec: null,
    models: ['deepseek/x'],
    objectKey: `artifacts/${extra.sessionId ?? s1}/${path}`,
    syncPath: `小木屋/${path}`,
    replacesSha256: null,
    ...extra,
  });

  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort())
      await pool.query(await part(file, 'up'));
  });
  afterAll(async () => {
    await pool.query(`drop schema if exists ${schema} cascade`);
    await pool.end();
  });

  it('同一话题同一路径只登记一次；按对话、话题列出；同步文件夹不算本话题', async () => {
    expect(await repo.insert(row('首页.md'))).toBe(true);
    expect(await repo.insert(row('首页.md', { runId: r2, syncPath: '小木屋/首页 (2).md' }))).toBe(
      false,
    );
    expect(await repo.insert(row('hero.png'))).toBe(true);
    expect(
      await repo.insert(
        row('首页.md', { sessionId: s2, topic: '小木屋', syncPath: '小木屋 (2)/首页.md' }),
      ),
    ).toBe(true);
    expect(
      await repo.insert(row('别人的.md', { ownerId: other, syncPath: '小木屋/别人的.md' })),
    ).toBe(true);

    expect((await repo.listBySession(s1)).map((r) => r.path).sort()).toEqual([
      'hero.png',
      '别人的.md',
      '首页.md',
    ]);
    expect(await repo.listByConversation(conversation)).toHaveLength(4);
    expect(await repo.list(owner, { sessionId: s2 }, 10)).toHaveLength(1);
    expect(await repo.list(owner, { conversationId: conversation }, 10)).toHaveLength(3);
    expect(await repo.list(owner, { category: 'media' }, 10)).toEqual([]);
    expect((await repo.syncDirs(owner, s1)).sort()).toEqual(['小木屋 (2)']);
    expect((await repo.syncDirs(owner, s2)).sort()).toEqual(['小木屋']);
    const ids = (await repo.listBySession(s1)).map((r) => r.id);
    expect((await repo.findMany([...ids, randomUUID()])).map((r) => r.id).sort()).toEqual(
      ids.sort(),
    );
    expect(await repo.findMany([])).toEqual([]);
  });

  it('后来的一轮原地换新版：批注、批准清掉，记下新的一轮；删行', async () => {
    const [first] = await repo.list(owner, { sessionId: s2 }, 10);
    await repo.setReview(first!.id, {
      annotations: [
        {
          id: randomUUID(),
          number: 1,
          note: '改',
          page: null,
          time: null,
          quote: null,
          shape: null,
          frame: null,
        },
      ],
      approvedAt: new Date(),
    });
    await repo.replaceContent(first!.id, {
      size: 9,
      sha256: 'b'.repeat(64),
      contentType: 'text/markdown',
      models: ['google/g'],
      replacesSha256: 'a'.repeat(64),
      runId: r2,
    });
    expect(await repo.find(first!.id)).toMatchObject({
      size: 9,
      sha256: 'b'.repeat(64),
      replacesSha256: 'a'.repeat(64),
      runId: r2,
      models: ['google/g'],
      annotations: [],
      approvedAt: null,
      syncPath: '小木屋 (2)/首页.md',
    });
    await repo.removeRows([first!.id]);
    expect(await repo.find(first!.id)).toBeUndefined();
  });

  it('收缩后话题四列必填；回退收缩只把旧列加回来（空的），再收缩一次也行', async () => {
    const bare = () =>
      pool.query(
        `insert into artifacts (id, owner_id, conversation_id, path, name, size, content_type,
           category, object_key, sync_path)
         values ($1, $2, $3, 'x.md', 'x.md', 1, 'text/markdown', 'doc', 'k', $4)`,
        [randomUUID(), owner, conversation, `无话题/${randomUUID()}.md`],
      );
    await expect(bare()).rejects.toThrow(/session_id/);
    await pool.query(await part(CONTRACT, 'down'));
    const { rows } = await pool.query<{ task_id: string | null }>('select task_id from artifacts');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.task_id === null)).toBe(true);
    await pool.query(await part(CONTRACT, 'up'));
    expect(await repo.insert(row('again.md'))).toBe(true);
  });
});
