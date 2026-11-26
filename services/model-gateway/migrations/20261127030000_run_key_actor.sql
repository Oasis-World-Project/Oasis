-- phase: expand
-- contract-plan: 不适用（只新增一列，没有被替换的旧结构需要收缩）
-- migrate:up
-- 群里的钱从金库出：这一轮是谁叫的记在临时 Key 上，冻结时带给 billing（金库页按人算花了多少）。
alter table run_keys add column actor_id uuid;

-- migrate:down
alter table run_keys drop column actor_id;
