// 开发库的表结构和迁移文件对得上吗：按迁移文件在临时库里从头建一遍，逐表逐列比。
// dbmate 只记版本号，改了已经应用过的迁移文件不会重跑（2026-11-08：nodes.retired_version 就这样漏了），
// 这里在跑场景之前就把这种漂移找出来。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { query } from './db.mjs';
import { readEnv, ROOT, SERVICES } from './stack.mjs';

const SNAPSHOT = `select table_name, column_name, data_type, is_nullable, coalesce(column_default, '') as column_default
  from information_schema.columns
  where table_schema = 'public' and table_name <> 'schema_migrations'
  order by table_name, column_name`;

function psql(user, args) {
  execFileSync(
    'docker',
    ['exec', 'oasis-postgres-1', 'psql', '-U', user, '-d', 'postgres', '-q', ...args],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
}

/** 返回不一致的地方（空数组表示一致） */
export async function schemaDrift() {
  const env = readEnv(path.join(ROOT, '.env'));
  const user = env.POSTGRES_SUPERUSER ?? 'oasis_admin';
  const kit = createRequire(path.join(ROOT, 'packages/service-kit/package.json'));
  const { resolveBinary } = await import(pathToFileURL(kit.resolve('dbmate')).href);
  const problems = [];
  for (const service of SERVICES) {
    const dir = path.join(ROOT, 'services', service, 'migrations');
    if (!existsSync(dir)) continue;
    const database = service.replaceAll('-', '_');
    const scratch = `e2e_schema_${database}`;
    psql(user, ['-c', `drop database if exists ${scratch}`, '-c', `create database ${scratch}`]);
    try {
      const result = spawnSync(
        resolveBinary(),
        ['--migrations-dir', dir, '--no-dump-schema', 'up'],
        {
          env: {
            ...process.env,
            // 密码只经环境变量交给 dbmate，不进命令行和日志
            DATABASE_URL: `postgres://${user}:${encodeURIComponent(env.POSTGRES_SUPERUSER_PASSWORD ?? '')}@127.0.0.1:${env.POSTGRES_HOST_PORT ?? 5432}/${scratch}?sslmode=disable`,
          },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      if (result.status !== 0) {
        problems.push(
          `${service}：迁移文件在空库里跑不通：${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        );
        continue;
      }
      const key = (c) => `${c.table_name}.${c.column_name}`;
      const actual = new Map(query(database, SNAPSHOT).map((c) => [key(c), c]));
      const expected = new Map(query(scratch, SNAPSHOT).map((c) => [key(c), c]));
      for (const [name, column] of expected) {
        const found = actual.get(name);
        if (!found) problems.push(`${service}：开发库缺列 ${name}`);
        else if (
          found.data_type !== column.data_type ||
          found.is_nullable !== column.is_nullable ||
          found.column_default !== column.column_default
        )
          problems.push(
            `${service}：列 ${name} 定义不同（开发库 ${found.data_type}/${found.is_nullable}，迁移文件 ${column.data_type}/${column.is_nullable}）`,
          );
      }
      for (const name of actual.keys())
        if (!expected.has(name)) problems.push(`${service}：开发库多了迁移文件里没有的列 ${name}`);
    } finally {
      psql(user, ['-c', `drop database if exists ${scratch}`]);
    }
  }
  return problems;
}
