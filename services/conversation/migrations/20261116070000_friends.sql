-- phase: expand
-- contract-plan: 群改成群主直接拉好友，邀请码不再用：下一个迁移 20261116070100_drop_group_invites 删掉 group_invites 表
-- migrate:up
-- 好友：申请（对方同意后变成好友，拒绝或撤回就删掉这一行）和好友关系（一对好友一行，小的 ID 在前）
create table friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null,
  to_id uuid not null,
  message text not null default '' check (length(message) <= 60),
  created_at timestamptz not null default now(),
  check (from_id <> to_id),
  unique (from_id, to_id)
);
create index friend_requests_to on friend_requests (to_id, created_at desc);
create table friendships (
  user_a uuid not null,
  user_b uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
create index friendships_b on friendships (user_b);
-- 人和人的私聊：kind = 'direct' 的一条会话，两个人都是它的成员，消息和推送用群的那一套。
-- direct_key 是两人的 ID（小的在前，冒号隔开），一对好友只有一个。
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('dm', 'group', 'seat', 'direct'));
alter table conversations add column direct_key text;
alter table conversations add constraint conversations_direct_check
  check ((kind = 'direct') = (direct_key is not null));
create unique index conversations_direct_once on conversations (direct_key) where kind = 'direct';
-- 群昵称：没设就显示账号的名字（display_name 记着账号的名字，账号改名后跟着改）
alter table group_members add column nickname text
  check (nickname is null or length(nickname) between 1 and 40);

-- migrate:down
alter table group_members drop column nickname;
delete from conversations where kind = 'direct';
drop index conversations_direct_once;
alter table conversations drop constraint conversations_direct_check;
alter table conversations drop column direct_key;
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check check (kind in ('dm', 'group', 'seat'));
drop table friendships;
drop table friend_requests;
