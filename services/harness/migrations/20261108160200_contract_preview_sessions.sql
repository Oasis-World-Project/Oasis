-- phase: contract
-- migrate:up
drop table preview_sessions;

-- migrate:down
-- 回滚前先停掉全部检查并完成结算；记录搬回旧表（旧表要求的 artifact_id、deadline_at 用 id、结束时间补上）
create table preview_sessions (
  id uuid primary key,
  artifact_id uuid not null,
  owner_id uuid not null,
  task_id uuid not null,
  status text not null check (status in ('starting', 'running', 'stopping', 'stopped', 'expired', 'failed')),
  container_id text,
  compute_call_id uuid,
  held_micro bigint not null default 0 check (held_micro >= 0),
  spent_micro bigint,
  started_at timestamptz,
  last_input_at timestamptz,
  deadline_at timestamptz not null,
  stopped_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
insert into preview_sessions (
  id, artifact_id, owner_id, task_id, status, container_id, compute_call_id,
  held_micro, spent_micro, started_at, deadline_at, stopped_at, error, created_at
)
select
  id, id, payer_id, task_id, status, container_id, compute_call_id,
  held_micro, spent_micro, started_at, coalesce(stopped_at, created_at), stopped_at, error, created_at
from check_browsers;
create unique index preview_one_active_per_owner on preview_sessions (owner_id)
  where status in ('starting', 'running', 'stopping');
create index preview_artifact_latest on preview_sessions (artifact_id, created_at desc);
