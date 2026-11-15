-- phase: contract
-- migrate:up
-- 群不再用邀请码进人（群主直接拉好友，见 20261116070000_friends）：还没用掉的邀请码一起删掉
drop table group_invites;

-- migrate:down
create table group_invites (
  token_hash text primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  expires_at timestamptz not null,
  used_by uuid,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index group_invites_group on group_invites(conversation_id);
