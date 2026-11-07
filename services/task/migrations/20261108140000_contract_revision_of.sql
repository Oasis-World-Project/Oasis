-- phase: contract
-- migrate:up
-- 旧式修订（ADR 0012 旧流程：修改另建一个新任务，交付后替换并删除上一版）的代码已删除（阶段 1，2026-11-08）。
-- 修改现在在原任务里做（ADR 0022）。删之前确认过没有 revision_of 不为空的任务。
drop index if exists tasks_one_active_revision;
alter table tasks drop column revision_of;

-- migrate:down
alter table tasks add column revision_of uuid;
create unique index tasks_one_active_revision on tasks (revision_of)
  where revision_of is not null
    and status in ('planning', 'running', 'accepting', 'stopped', 'needs_attention');
