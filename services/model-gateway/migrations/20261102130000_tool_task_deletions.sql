-- phase: expand
-- contract-plan: Durable task deletion admission fence; no replaced table, dual writes or legacy columns. Before rollback drain tool jobs and the task-deleted consumer; rollback removes only deletion markers, never billing records.
-- migrate:up
create table tool_task_deletions (
  task_id uuid primary key,
  deleted_at timestamptz not null default now()
);
create index tool_jobs_task on tool_jobs ((call->'caller'->>'taskId'));
-- migrate:down
drop index tool_jobs_task;
drop table tool_task_deletions;
