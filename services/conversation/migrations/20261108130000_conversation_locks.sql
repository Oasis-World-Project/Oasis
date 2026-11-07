-- phase: expand
-- contract-plan: 不适用（只新增一张表，没有被它替代的旧结构）。注意：旧实例用会话级 advisory lock、新实例用这张表，
-- 两种锁互不认识，发布时整批替换 conversation 实例，不和旧实例混跑。
-- migrate:up
-- 会话处理锁（同一会话同时只处理一轮回复、只整理一件任务）：租约到期自动失效，持有方每 10 秒续一次。
-- 不再占着连接池里的一条连接等模型回复——2026-11-08 回归：6 个用户同时发任务，每轮占 2 条连接，
-- 10 条的连接池被占满，别的查询 3 秒拿不到连接，接需求失败。
create table conversation_locks (
  key text primary key,
  holder uuid not null,
  expires_at timestamptz not null
);

-- migrate:down
drop table conversation_locks;
