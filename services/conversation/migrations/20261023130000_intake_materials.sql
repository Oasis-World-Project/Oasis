-- phase: expand
-- contract-plan: 不适用（只新增带默认值的列，旧的接需求记录没有素材，空数组即正确值）
-- migrate:up
-- 接需求期间用户随消息发的文件（存在 canvas）；确认任务单时交给 task（ADR 0007 §4）
alter table intakes add column materials jsonb not null default '[]';

-- migrate:down
alter table intakes drop column materials;
