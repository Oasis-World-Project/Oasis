// 在一个事务里做一件事：出错回滚，做完提交。
import type pg from 'pg';

export async function inTransaction<T>(
  pool: pg.Pool,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    const value = await work(db);
    await db.query('commit');
    return value;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}
