-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

-- 登录验证码：只存哈希；同一邮箱可能有多条，用最新一条未使用、未过期的
create table email_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_codes_email_created on email_codes (email, created_at desc);

-- 登录会话：只存令牌的哈希
create table sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index sessions_user on sessions (user_id);

-- 事务发件箱（service-kit 的 startOutboxRelay 负责投递）
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;

-- migrate:down
drop table outbox;
drop table sessions;
drop table email_codes;
drop table users;
