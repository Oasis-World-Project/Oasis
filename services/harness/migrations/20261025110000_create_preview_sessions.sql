-- phase: expand
-- contract-plan: 新生命周期独立于 agent runs，无旧列可删。启用后清理过渡逻辑并审计活跃会话已闭合；回滚前先停止全部预览并完成结算。
-- migrate:up
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
create unique index preview_one_active_per_owner on preview_sessions (owner_id)
  where status in ('starting', 'running', 'stopping');
create index preview_artifact_latest on preview_sessions (artifact_id, created_at desc);

-- migrate:down
drop table preview_sessions;
