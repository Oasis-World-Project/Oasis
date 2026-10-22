-- phase: expand
-- contract-plan: 不适用（只放宽状态的取值范围、新增可空或带默认值的列和发件箱表，没有旧结构需要收缩）
-- migrate:up
-- 5.3：任务可以从任务单开始，先由规划员排工作流；跑完对照任务单整体验收（ADR 0005 §4、§5）
alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status in ('planning', 'running', 'accepting', 'stopped', 'needs_attention', 'succeeded', 'failed', 'cancelled'));
alter table tasks
  -- 用户确认的任务单
  add column sheet jsonb,
  -- 每样交付物由哪个节点交出 [{name, form, nodeId}]
  add column deliverables jsonb not null default '[]',
  -- 规划员这次运行，以及已经规划了几次（含规划门退回后的修改）
  add column planner_run_id uuid,
  add column plan_attempts integer not null default 0,
  -- 整体验收的结果 {unmet: [...]}
  add column acceptance jsonb;

-- 事务发件箱：任务状态变了就发 task.task.status_changed（conversation 更新任务卡、发交付消息）
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;

-- migrate:down
drop table outbox;
alter table tasks
  drop column acceptance,
  drop column plan_attempts,
  drop column planner_run_id,
  drop column deliverables,
  drop column sheet;
-- 回滚后旧代码不认识 planning：还没排出方案的任务只能取消
update tasks set status = 'cancelled', finished_at = now() where status = 'planning';
-- 验收到一半的直接算完成
update tasks set status = 'succeeded', finished_at = now() where status = 'accepting';
alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check
  check (status in ('running', 'stopped', 'needs_attention', 'succeeded', 'failed', 'cancelled'));
