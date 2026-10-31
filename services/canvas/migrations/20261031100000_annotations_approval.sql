-- phase: expand
-- contract-plan: 不适用（只新增带默认值或可空的列，旧成果没有批注、没有批准即正确值，没有旧结构需要收缩）
-- migrate:up
-- 5.11b 批注与批准（ADR 0012 §9）：批注跟着成果走，成果被删除或被新版替换时一起消失
alter table artifacts add column annotations jsonb not null default '[]';
-- 用户点了「批准」的时间（只是记号，不挡修改）
alter table artifacts add column approved_at timestamptz;

-- migrate:down
alter table artifacts drop column approved_at;
alter table artifacts drop column annotations;
