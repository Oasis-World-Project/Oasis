-- phase: expand
-- contract-plan: Backfill message seq in 20261102150100, then enforce seq constraints in 20261102150200. Reuse conversations/messages; members and invites are new relationship lifecycles, not replacement copies. Stop group traffic before rollback.
-- migrate:up
lock table conversations, messages in share row exclusive mode;
alter table conversations add column next_message_seq bigint not null default 0;
alter table messages add column seq bigint;
update conversations c set next_message_seq=(select count(*) from messages m where m.conversation_id=c.id);
create function allocate_message_seq() returns trigger language plpgsql as $$
begin
  update conversations set next_message_seq=next_message_seq+1 where id=new.conversation_id returning next_message_seq into new.seq;
  return new;
end $$;
create trigger messages_allocate_seq before insert on messages for each row execute function allocate_message_seq();
create table group_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null,
  display_name text not null check (length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key(conversation_id,user_id)
);
create index group_members_user on group_members(user_id) where left_at is null;
create table group_invites (
  token_hash text primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  expires_at timestamptz not null,
  used_by uuid,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index group_invites_group on group_invites(conversation_id);
create unique index messages_client_request on messages(conversation_id,author_kind,author_id,(data->>'clientRequestId')) where data ? 'clientRequestId';
-- migrate:down
drop index messages_client_request;
drop table group_invites;
drop table group_members;
drop trigger messages_allocate_seq on messages;
drop function allocate_message_seq();
alter table messages drop column seq;
alter table conversations drop column next_message_seq;
