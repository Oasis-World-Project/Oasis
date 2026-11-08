-- phase: contract
-- 网页的浏览器检查搬进 inspector（ADR 0024）：检查浏览器用完即删、算力由调用方结算，不再记在 harness。
-- migrate:up
drop table check_browsers;

-- migrate:down
-- 回滚只建回空表：搬走前的检查都已结束、结清，不需要记录
create table check_browsers (
  id uuid primary key,
  payer_id uuid not null,
  task_id uuid not null,
  status text not null check (status in ('starting', 'running', 'stopping', 'stopped', 'failed')),
  container_id text,
  compute_call_id uuid,
  held_micro bigint not null default 0 check (held_micro >= 0),
  spent_micro bigint,
  started_at timestamptz,
  stopped_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index check_browsers_unfinished on check_browsers (status)
  where status in ('starting', 'running', 'stopping');
create index check_browsers_task on check_browsers (task_id);
