-- phase: expand
-- contract-plan: 不适用（只新增一列，没有被替换的旧结构需要收缩）
-- migrate:up
-- 用户关了这段对话的联网搜索：记在这一轮的临时 Key 上，这一轮没有联网搜索、读网页这两个工具。
alter table run_keys add column no_web boolean not null default false;

-- migrate:down
alter table run_keys drop column no_web;
