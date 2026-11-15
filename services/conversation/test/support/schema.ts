// 真实数据库的测试：开一个临时 schema，把迁移从头跑一遍；用完整个删掉。
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

export function scratchSchema(prefix: string) {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    async create() {
      await pool.query(`create schema ${schema}`);
      const root = new URL('../../migrations/', import.meta.url);
      for (const file of (await readdir(root)).filter((name) => name.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(file, root), 'utf8');
        await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
      }
    },
    async drop() {
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    },
  };
}
