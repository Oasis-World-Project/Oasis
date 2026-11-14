-- phase: contract
-- migrate:up
-- 撤掉 task 服务后的收缩（第 2 阶段，用户 11-14 确认清空全部旧数据之后）：一次运行就是私聊里的一轮，一定属于
-- 一个对话；没有任务、节点和上游产出。harness 也不发事件，发件箱一直空着。
drop index if exists runs_task_node;
alter table runs
  drop column task_id,
  drop column node_id,
  drop column inputs_from,
  alter column conversation_id set not null;
drop table outbox;

-- migrate:down
-- 回退把列和表建回来（空的、可空）：旧数据清空时已经没了
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;
alter table runs
  alter column conversation_id drop not null,
  add column task_id uuid,
  add column node_id uuid,
  add column inputs_from jsonb not null default '[]';
create index runs_task_node on runs (task_id, node_id) where task_id is not null;
