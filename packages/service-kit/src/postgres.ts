// 服务自己的 PostgreSQL 库。每个服务只能连自己的库（账号在数据库层面就连不上别人的库）。
import pg from 'pg';
import { z } from 'zod';
import type { Logger } from './logger.ts';
import type { ServiceResource } from './resource.ts';

export const databaseEnv = {
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
};

export interface PostgresResource extends ServiceResource {
  readonly pool: pg.Pool;
}

export function createPostgres(connectionString: string, logger: Logger): PostgresResource {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => logger.error({ err }, 'PostgreSQL 空闲连接出错'));
  return {
    name: 'postgres',
    pool,
    async ready() {
      await pool.query('select 1');
    },
    async close() {
      await pool.end();
    },
  };
}
