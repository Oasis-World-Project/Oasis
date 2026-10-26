-- phase: expand
-- contract-plan: 应用描述是新增可空能力；5.7a 不替换旧列。启用写入后检查没有临时双写，再收束实现中的兼容分支；旧成果继续保持 null。
-- migrate:up
alter table artifacts add column app_spec jsonb;

-- migrate:down
alter table artifacts drop column app_spec;
