-- phase: expand
-- contract-plan: 不适用（只新增可空列和部分唯一索引，旧任务的 revision_of 为空即正确值，没有旧结构需要收缩）
-- migrate:up
-- 5.11 修改成果（ADR 0012）：这是哪个任务的新版。新版交付后整体替换上一版，上一版随之删除。
alter table tasks add column revision_of uuid;
-- 同一份上一版同时只能有一个没结束的修订任务
create unique index tasks_one_active_revision on tasks (revision_of)
  where revision_of is not null
    and status in ('planning', 'running', 'accepting', 'stopped', 'needs_attention');

-- migrate:down
drop index tasks_one_active_revision;
alter table tasks drop column revision_of;
