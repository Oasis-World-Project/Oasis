// 只读查询本机开发数据库（经 postgres 容器里的 psql，用超级用户跨库查）：任务追踪和回归断言共用。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readEnv, ROOT } from './stack.mjs';

const CONTAINER = 'oasis-postgres-1';

/** 跑一条 SELECT，结果是对象数组（列名即字段名） */
export function query(database, sql) {
  const user = readEnv(path.join(ROOT, '.env')).POSTGRES_SUPERUSER ?? 'oasis_admin';
  const wrapped = `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (${sql}) t`;
  const out = execFileSync(
    'docker',
    [
      'exec',
      CONTAINER,
      'psql',
      '-U',
      user,
      '-d',
      database,
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      wrapped,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
  );
  return JSON.parse(out.trim() || '[]');
}

/** 改数据（只给回归测试「快进时间」这类明确的场景用） */
export function execute(database, sql) {
  const user = readEnv(path.join(ROOT, '.env')).POSTGRES_SUPERUSER ?? 'oasis_admin';
  execFileSync(
    'docker',
    [
      'exec',
      CONTAINER,
      'psql',
      '-U',
      user,
      '-d',
      database,
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}

/** SQL 字面量（只给 UUID 和简单文本用） */
export const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
