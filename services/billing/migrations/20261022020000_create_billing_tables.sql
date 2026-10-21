-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
-- 钱包：金额都是微美元整数（1 USD = 1_000_000）。可用余额 = balance - held。
create table wallets (
  user_id uuid primary key,
  balance_micro bigint not null default 0 check (balance_micro >= 0),
  held_micro bigint not null default 0 check (held_micro >= 0 and held_micro <= balance_micro),
  granted_micro bigint not null default 0 check (granted_micro >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 调用模型前的冻结；结算或释放后关闭。过期未结算的由后台释放
create table holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references wallets (user_id),
  amount_micro bigint not null check (amount_micro > 0),
  status text not null default 'open' check (status in ('open', 'settled', 'released')),
  reason text not null,
  ref text not null,
  charged_micro bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);
create index holds_open_expiry on holds (expires_at) where status = 'open';

-- 流水：每一笔余额变动都留痕（grant 增加，charge 扣减；amount 一律为正数）
create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('grant', 'charge')),
  amount_micro bigint not null check (amount_micro >= 0),
  hold_id uuid,
  ref text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create unique index ledger_signup_grant_once on ledger_entries (user_id) where kind = 'grant' and ref = 'signup';
create index ledger_user_created on ledger_entries (user_id, created_at);

-- 已处理过的事件：事件可能重复投递，靠这张表保证只处理一次
create table processed_events (
  event_id uuid primary key,
  processed_at timestamptz not null default now()
);

-- migrate:down
drop table processed_events;
drop table ledger_entries;
drop table holds;
drop table wallets;
