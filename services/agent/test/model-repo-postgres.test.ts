// 真实数据库：每个 AI 的可选型号（第一个是默认）、用户给各个 AI 选的档位，收缩迁移的回退。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelRepo } from '../src/repo/model-repo.ts';

const CONTRACT = '20261114210100_contract_model_options.sql';

describe.skipIf(!process.env.TEST_DATABASE_URL)('可选型号和选的档位（真实数据库）', () => {
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

  it('接入的 AI 都有可选型号，第一个是快速档；一个 AI 每档最多一个', async () => {
    const models = await repo.list();
    const usable = models.filter((m) => m.options.length > 0);
    expect(usable.length).toBe(12);
    expect(models.filter((m) => m.options.length === 0).map((m) => m.key)).toEqual([
      'ernie',
      'spark',
    ]);
    for (const model of usable) {
      expect(model.options[0]?.tier).toBe('fast');
      const tiers = model.options.map((o) => o.tier);
      expect(new Set(tiers).size).toBe(tiers.length);
      for (const option of model.options) {
        expect(option.model).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
        expect(option.inputPrice).toBeGreaterThan(0);
        expect(option.outputPrice).toBeGreaterThan(0);
      }
    }
    expect((await repo.find('deepseek'))?.options.map((o) => o.label)).toEqual([
      'DeepSeek V4.1 Flash',
      'DeepSeek V4 Pro',
    ]);
  });

  it('选档位只改这一个 AI，不动别的 AI 和「只用国内模型」', async () => {
    const user = randomUUID();
    expect(await repo.settings(user)).toEqual({ domesticOnly: false, tiers: {} });
    await repo.saveTier(user, 'deepseek', 'strong');
    await repo.saveSettings(user, { domesticOnly: true });
    await repo.saveTier(user, 'qwen', 'strong');
    await repo.saveTier(user, 'deepseek', 'fast');
    expect(await repo.settings(user)).toEqual({
      domesticOnly: true,
      tiers: { deepseek: 'fast', qwen: 'strong' },
    });
    expect(await repo.settings(randomUUID())).toEqual({ domesticOnly: false, tiers: {} });
  });

  it('收缩迁移能回退：默认型号回到 provider_model、version_label', async () => {
    await pool.query(await part(CONTRACT, 'down'));
    const { rows } = await pool.query<{ provider_model: string | null; version_label: string }>(
      `select provider_model, version_label from models where key = 'deepseek'`,
    );
    expect(rows).toEqual([
      { provider_model: 'deepseek/deepseek-v4.1-flash', version_label: 'DeepSeek V4.1 Flash' },
    ]);
    await pool.query(await part(CONTRACT, 'up'));
    expect((await repo.find('deepseek'))?.options).toHaveLength(2);
  });
});
