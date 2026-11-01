-- phase: expand
-- contract-plan: 数字人配置是新增可空能力（ADR 0013），不替换旧列；旧成果保持 null。
-- migrate:up
-- 交付物里的 `<名字>.oasis-avatar.json` 校验通过后存在这里，成果页据此开实时对话
alter table artifacts add column avatar_spec jsonb;

-- migrate:down
alter table artifacts drop column avatar_spec;
