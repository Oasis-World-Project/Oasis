// 开几份服务时要一起认的两件小事，都记在 conversation_locks 这张租约表里（不加表）：
// 「隔一会儿做一遍」的事一段时间里只让一份做（tick）；「这个群现在有人开着」（touch、alive）。
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export function createLeases(pool: pg.Pool) {
  return {
    /** 这段时间（ttlMs）里第一个来的拿到 true，之后来的（别的实例，或自己再来）都是 false */
    async tick(name: string, ttlMs: number): Promise<boolean> {
      const { rowCount } = await pool.query(
        `insert into conversation_locks (key, holder, expires_at)
         values ($1, $2, now() + make_interval(secs => $3))
         on conflict (key) do update set holder = excluded.holder, expires_at = excluded.expires_at
         where conversation_locks.expires_at < now()`,
        [`tick:${name}`, randomUUID(), ttlMs / 1000],
      );
      return Boolean(rowCount);
    },
    /** 记下这些群现在有人开着，ttlMs 内算数（到时没再记就不算了） */
    async touch(groupIds: string[], ttlMs: number): Promise<void> {
      if (!groupIds.length) return;
      await pool.query(
        `insert into conversation_locks (key, holder, expires_at)
         select 'watch:' || id, $2, now() + make_interval(secs => $3) from unnest($1::text[]) as id
         on conflict (key) do update set expires_at = excluded.expires_at`,
        [groupIds, randomUUID(), ttlMs / 1000],
      );
    },
    /** 这个群现在有没有人开着（哪一份服务上连着都算） */
    async alive(groupId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        'select 1 from conversation_locks where key = $1 and expires_at > now()',
        [`watch:${groupId}`],
      );
      return Boolean(rowCount);
    },
    /** 清掉过期一小时以上的租约（崩掉的进程留下的锁、没人开着的群） */
    async prune(): Promise<void> {
      await pool.query(
        "delete from conversation_locks where expires_at < now() - interval '1 hour'",
      );
    },
  };
}
