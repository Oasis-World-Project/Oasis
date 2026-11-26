-- phase: expand
-- contract-plan: 不适用（只新增一列，没有被替换的旧结构需要收缩）
-- migrate:up
-- 付钱的账户和人拆开：payer_id 是花哪个账户的钱（个人的是用户 ID，群的金库是群的 ID），
-- actor_id 是这一轮替谁做的（他的电脑、他名下的文件）；空就是付钱的那个人自己。
alter table runs add column actor_id uuid;

-- migrate:down
alter table runs drop column actor_id;
