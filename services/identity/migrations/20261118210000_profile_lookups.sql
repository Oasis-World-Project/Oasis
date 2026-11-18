-- phase: expand
-- contract-plan: 不适用（新增一张表，没有被替换的旧结构需要收缩）
-- migrate:up
-- 按账号 ID 查人的次数限制：每查一次记一行，只留最近一分钟的。原来记在进程内存里，开两份服务时各算各的。
create table profile_lookups (
  user_id uuid not null references users (id) on delete cascade,
  at timestamptz not null
);
create index profile_lookups_user_at on profile_lookups (user_id, at);

-- migrate:down
drop table profile_lookups;
