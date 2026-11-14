-- phase: expand
-- contract-plan: 新表，没有旧结构要收缩
-- migrate:up
-- 用户给 AI 们的设置（2026-11-14）：「只用国内模型」从 model-gateway 挪到这里（开一轮时随这一轮往下传），
-- 以后每个 AI 选哪个型号也记在这里。没有行就是默认设置。
create table user_ai_settings (
  user_id uuid primary key,
  domestic_only boolean not null default false,
  updated_at timestamptz not null default now()
);

-- migrate:down
drop table user_ai_settings;
