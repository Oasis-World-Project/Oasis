// 真实数据库：用户给各个 AI 选的档位和定的设定，「只用国内模型」；迁移能回退。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRepo } from '../src/repo/model-repo.ts';

const DROP_MODELS = '20261115030100_drop_models.sql';
const PROFILES = '20261115030000_ai_profiles.sql';

describe.skipIf(!process.env.TEST_DATABASE_URL)('用户给 AI 们的设置（真实数据库）', () => {
  const schema = 'agent_test_' + randomUUID().replaceAll('-', '');
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const repo = createModelRepo(pool);
  const root = new URL('../migrations/', import.meta.url);
  const part = async (file: string, which: 'up' | 'down') => {
    const [, rest] = (await readFile(new URL(file, root), 'utf8')).split('-- migrate:up');
    const [up, down] = rest!.split('-- migrate:down');
    return which === 'up' ? up! : down!;
  };

  beforeAll(async () => {
    await pool.query(`create schema ${schema}`);
    for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort())
      await pool.query(await part(file, 'up'));
  });
  afterAll(async () => {
    await pool.query(`drop schema if exists ${schema} cascade`);
    await pool.end();
  });

  it('选档位、定设定只改这一个 AI，不动别的 AI 和「只用国内模型」；设定整份替换', async () => {
    const user = randomUUID();
    expect(await repo.settings(user)).toEqual({ domesticOnly: false, tiers: {}, profiles: {} });
    await repo.saveAi(user, 'deepseek', 'strong', { name: '小深', persona: '说话简短' });
    await repo.saveSettings(user, { domesticOnly: true });
    await repo.saveAi(user, 'qwen', 'strong', {});
    await repo.saveAi(user, 'deepseek', 'fast', { name: '小深' });
    expect(await repo.settings(user)).toEqual({
      domesticOnly: true,
      tiers: { deepseek: 'fast', qwen: 'strong' },
      profiles: { deepseek: { name: '小深' }, qwen: {} },
    });
    expect(await repo.settings(randomUUID())).toEqual({
      domesticOnly: false,
      tiers: {},
      profiles: {},
    });
  });

  it('迁移能回退：models 表建回来（空的），设定那一列去掉再加回来', async () => {
    await pool.query(await part(DROP_MODELS, 'down'));
    const { rows } = await pool.query<{ n: string }>('select count(*) as n from models');
    expect(rows).toEqual([{ n: '0' }]);
    await pool.query(await part(DROP_MODELS, 'up'));
    await pool.query(await part(PROFILES, 'down'));
    await pool.query(await part(PROFILES, 'up'));
    const user = randomUUID();
    await repo.saveAi(user, 'kimi', 'fast', { gender: 'female' });
    expect((await repo.settings(user)).profiles).toEqual({ kimi: { gender: 'female' } });
  });
});
