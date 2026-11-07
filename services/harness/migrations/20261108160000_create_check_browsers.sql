-- phase: expand
-- contract-plan: 取代 preview_sessions（平台预览已删除，ADR 0021；剩下的只有检查用浏览器）。20261108160100 把旧记录搬过来，20261108160200 删除旧表。
-- migrate:up
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

-- migrate:down
drop table check_browsers;
