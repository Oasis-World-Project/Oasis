-- phase: contract
-- migrate:up
-- 预算、预估和花费上限整套去掉（2026-11-13）：任务上只留已经花了多少（spent_micro）。
-- 读写这两列的代码在同一次改动里删掉；budget_limit_micro 一直是空的，estimate_micro 只用于显示。
alter table tasks drop column estimate_micro;
alter table tasks drop column budget_limit_micro;

-- migrate:down
alter table tasks add column estimate_micro bigint;
alter table tasks add column budget_limit_micro bigint;
