-- phase: expand
-- contract-plan: 清空旧数据后（第 2 阶段，用户确认）删 calls、run_keys、tool_run_controls、avatar_sessions 的 task_id 和 node_id，删 tool_task_deletions 表、tool_jobs_task 索引和 outbox 表
-- migrate:up
-- 撤掉 task 服务（2026-11-14）：调用记录、临时 Key、按运行取消工具改记对话；删对话时按对话拦住迟到的工具提交、清掉工具的结果。
alter table calls add column conversation_id uuid;
alter table run_keys add column conversation_id uuid;
alter table tool_run_controls add column conversation_id uuid;
create table tool_conversation_deletions (
  conversation_id uuid primary key,
  deleted_at timestamptz not null default now()
);
create index tool_jobs_conversation on tool_jobs ((call->'caller'->>'conversationId'));

-- migrate:down
drop index tool_jobs_conversation;
drop table tool_conversation_deletions;
alter table tool_run_controls drop column conversation_id;
alter table run_keys drop column conversation_id;
alter table calls drop column conversation_id;
