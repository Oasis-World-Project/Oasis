-- phase: contract
-- migrate:up
-- 旧式修订的素材（上一版成果登记成上传、记下来自哪个任务，ADR 0012 旧流程）的代码已删除（阶段 1，2026-11-08）。
-- 删之前确认过没有 source_task_id 不为空的上传。artifacts.replaces_sha256 原地更新成果时仍在用，保留。
drop index if exists uploads_source_task;
alter table uploads drop column source_task_id;

-- migrate:down
alter table uploads add column source_task_id uuid;
create index uploads_source_task on uploads (source_task_id) where source_task_id is not null;
