-- phase: expand
-- contract-plan: 清空旧数据后（第 2 阶段，用户确认）删 task_id、node_id、inputs_from 和 outbox 表，conversation_id 改成 not null
-- migrate:up
-- 撤掉 task 服务（2026-11-14）：一轮 = 一次运行，跟着对话走；删对话时按它清理运行和工作目录。
alter table runs add column conversation_id uuid;
create index runs_conversation on runs (conversation_id);

-- migrate:down
drop index runs_conversation;
alter table runs drop column conversation_id;
