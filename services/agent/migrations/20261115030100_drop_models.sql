-- phase: contract
-- migrate:up
-- AI 们和各档型号改写在型号清单里（packages/contracts/src/lineup.ts，2026-11-15 用户定：所有型号写在一个
-- 地方），这张表不用了。同时 Llama 换成 Muse、去掉讯飞星火：选过的档位里这两个的记录也去掉。
drop table models;
update user_ai_settings set tiers = tiers - 'llama' - 'spark';

-- migrate:down
-- 只把表结构建回来（空的）：AI 们在型号清单里
create table models (
  key text primary key,
  name text not null,
  vendor text not null,
  category text not null check (category in ('llm', 'image', 'vision', 'video', 'audio', 'embedding', '3d', 'other')),
  tags text[] not null default '{}',
  mono text not null,
  glow text not null,
  options jsonb not null default '[]',
  sort_order integer not null,
  created_at timestamptz not null default now()
);
