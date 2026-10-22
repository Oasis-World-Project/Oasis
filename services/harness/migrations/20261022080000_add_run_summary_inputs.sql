-- phase: expand
-- contract-plan: 不适用（只新增可空列和带默认值的列，没有旧结构需要收缩）
-- migrate:up
-- summary：AI 最后说的一句话（工作流里交给下游节点、界面展示）
-- inputs_from：这次运行用了哪些之前运行的产出作为输入 [{runId, as}]（排查、重放用）
alter table runs
  add column summary text,
  add column inputs_from jsonb not null default '[]';

-- migrate:down
alter table runs
  drop column inputs_from,
  drop column summary;
