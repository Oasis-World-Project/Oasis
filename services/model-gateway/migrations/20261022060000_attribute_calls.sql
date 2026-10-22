-- phase: expand
-- contract-plan: 不适用（只新增可空列和带默认值的列，没有旧结构需要收缩；旧记录都是私聊的聊天调用，kind 默认 chat 即正确值）
-- migrate:up
-- 调用记录增加归属：是聊天还是决策调用，以及（agent 运行时）属于哪个运行、任务和节点
alter table calls
  add column kind text not null default 'chat' check (kind in ('chat', 'decision')),
  add column run_id uuid,
  add column task_id uuid,
  add column node_id uuid;
create index calls_run on calls (run_id) where run_id is not null;

-- migrate:down
drop index calls_run;
alter table calls
  drop column node_id,
  drop column task_id,
  drop column run_id,
  drop column kind;
