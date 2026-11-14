-- phase: contract
-- migrate:up
-- 撤掉 task 服务后的收缩（第 2 阶段，用户 11-14 确认清空全部旧数据之后）：成果只跟着对话、话题和登记它的
-- 那一轮走，不再有任务、节点和交付物。
drop index if exists artifacts_once;
alter table artifacts
  drop column task_id,
  drop column task_title,
  drop column node_id,
  drop column deliverable,
  alter column conversation_id set not null,
  alter column session_id set not null,
  alter column run_id set not null,
  alter column topic set not null;

-- migrate:down
-- 回退只把旧列加回来（可空）：旧数据清空时已经没了
alter table artifacts
  alter column topic drop not null,
  alter column run_id drop not null,
  alter column session_id drop not null,
  alter column conversation_id drop not null,
  add column task_id uuid,
  add column task_title text,
  add column node_id uuid,
  add column deliverable text;
create unique index artifacts_once on artifacts (task_id, node_id, path);
