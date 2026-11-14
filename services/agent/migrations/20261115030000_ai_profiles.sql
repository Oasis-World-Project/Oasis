-- phase: expand
-- contract-plan: 新加一列，没有旧结构要收缩
-- migrate:up
-- 用户给各个 AI 定的设定（2026-11-15「AI 们」设置页）：AI 的 key → 名字、性别、人格描述、其他要记住的。
-- 带进它的每一轮；没定的用系统默认。
alter table user_ai_settings add column profiles jsonb not null default '{}';

-- migrate:down
alter table user_ai_settings drop column profiles;
