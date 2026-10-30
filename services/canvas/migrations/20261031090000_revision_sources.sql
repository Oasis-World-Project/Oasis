-- phase: expand
-- contract-plan: 不适用（只新增可空列和索引，旧数据为空即正确值，没有旧结构需要收缩）
-- migrate:up
-- 5.11 修改成果（ADR 0012）
-- 修订任务的素材：上一版的交付文件登记成上传记录，记下来自哪个任务；那个任务被删时一并删除
alter table uploads add column source_task_id uuid;
create index uploads_source_task on uploads (source_task_id) where source_task_id is not null;
-- 新版替换旧版时，同一同步路径上旧文件的摘要（桌面端据此判断能不能覆盖电脑上的旧文件）
alter table artifacts add column replaces_sha256 text;

-- migrate:down
alter table artifacts drop column replaces_sha256;
drop index uploads_source_task;
alter table uploads drop column source_task_id;
