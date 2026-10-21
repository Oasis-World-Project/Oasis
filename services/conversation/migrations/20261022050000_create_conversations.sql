-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
-- 会话：私聊（dm，一个用户 + 一个 AI）；群聊（group）在后续阶段启用
create table conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('dm', 'group')),
  owner_id uuid not null,
  model_key text,
  title text not null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  check (kind <> 'dm' or model_key is not null)
);
-- 同一个用户和同一个 AI 只有一个私聊
create unique index conversations_dm_once on conversations (owner_id, model_key) where kind = 'dm';
create index conversations_owner on conversations (owner_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  author_kind text not null check (author_kind in ('user', 'ai')),
  author_id text not null,
  content text not null,
  status text not null check (status in ('complete', 'streaming', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index messages_conversation_created on messages (conversation_id, created_at);

-- migrate:down
drop table messages;
drop table conversations;
