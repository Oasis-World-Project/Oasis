-- phase: contract
-- migrate:up
-- 撤掉 task 服务后的收缩（第 2 阶段，用户 11-14 确认清空全部旧数据之后）：调用、临时 Key、按运行取消工具、
-- 数字人会话只记对话和这一轮，不记任务和节点；删对话时拦迟到的工具提交用 tool_conversation_deletions；
-- 不再给 task 发调用结算的事件，发件箱不要了；「只用国内模型」存在 agent，开一轮时随临时 Key 带来。
alter table calls drop column task_id, drop column node_id;
alter table run_keys drop column task_id, drop column node_id;
alter table tool_run_controls drop column task_id;
alter table avatar_sessions drop column task_id;
drop index if exists tool_jobs_task;
drop table tool_task_deletions;
drop table outbox;
drop table model_scopes;

-- migrate:down
-- 回退把列和表建回来（空的、可空）：旧数据清空时已经没了
create table model_scopes (
  user_id uuid primary key,
  domestic_only boolean not null,
  updated_at timestamptz not null default now()
);
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;
create table tool_task_deletions (
  task_id uuid primary key,
  deleted_at timestamptz not null default now()
);
create index tool_jobs_task on tool_jobs ((call->'caller'->>'taskId'));
alter table avatar_sessions add column task_id uuid;
alter table tool_run_controls add column task_id uuid;
alter table run_keys add column task_id uuid, add column node_id uuid;
alter table calls add column task_id uuid, add column node_id uuid;
