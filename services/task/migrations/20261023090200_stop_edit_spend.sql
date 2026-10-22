-- phase: expand
-- contract-plan: 不适用（只放宽状态的取值范围、新增可空列和新表，没有旧结构需要收缩）
-- migrate:up
-- 5.2c：用户新建的节点先是 draft（不自动开跑）；运行可以被「停止」；任务有花费上限
alter table nodes drop constraint nodes_status_check;
alter table nodes add constraint nodes_status_check
  check (status in ('draft', 'waiting', 'running', 'checking', 'succeeded', 'failed', 'stopped', 'blocked', 'cancelled'));
alter table node_runs drop constraint node_runs_status_check;
alter table node_runs add constraint node_runs_status_check
  check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'stopped'));
-- 花到这么多就暂停问用户（预估的 3 倍；用户选择继续后再加 3 倍预估）
alter table tasks add column budget_limit_micro bigint;
update tasks set budget_limit_micro = estimate_micro * 3 where estimate_micro is not null;

-- 已经计入花费的模型调用：model-gateway 的结算事件可能重复到达，按调用 ID 只算一次。
-- 不能放进 tasks / nodes：幂等要按每一次调用记，一个任务有成百上千次调用。
create table spend_records (
  call_id uuid primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  node_id uuid,
  charged_micro bigint not null,
  created_at timestamptz not null default now()
);
create index spend_records_task on spend_records (task_id);

-- migrate:down
drop table spend_records;
alter table tasks drop column budget_limit_micro;
update node_runs set status = 'cancelled' where status = 'stopped';
alter table node_runs drop constraint node_runs_status_check;
alter table node_runs add constraint node_runs_status_check
  check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled'));
-- 回滚后旧代码不认识 draft：改成「断开」，同样不会自动开跑
update nodes set status = 'blocked' where status = 'draft';
alter table nodes drop constraint nodes_status_check;
alter table nodes add constraint nodes_status_check
  check (status in ('waiting', 'running', 'checking', 'succeeded', 'failed', 'stopped', 'blocked', 'cancelled'));
