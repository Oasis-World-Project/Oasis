-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
-- 每一次模型调用的记录，用于对账和排查（金额是微美元整数）
create table calls (
  id uuid primary key,
  payer_id uuid not null,
  model text not null,
  request_id text,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  hold_id uuid,
  prompt_tokens integer,
  completion_tokens integer,
  upstream_cost_micro bigint,
  charged_micro bigint,
  cost_source text check (cost_source in ('provider', 'tokens', 'estimate')),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index calls_payer_created on calls (payer_id, created_at);

-- migrate:down
drop table calls;
