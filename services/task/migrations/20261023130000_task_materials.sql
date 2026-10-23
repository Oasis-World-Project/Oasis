-- phase: expand
-- contract-plan: 不适用（只新增带默认值的列，旧任务没有素材，空数组即正确值）
-- migrate:up
-- 用户给的素材（存在 canvas）：规划员和每个节点运行时放进沙箱的 materials/ 下（ADR 0007 §4）
alter table tasks add column materials jsonb not null default '[]';

-- migrate:down
alter table tasks drop column materials;
