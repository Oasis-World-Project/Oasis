-- phase: expand
-- contract-plan: 不适用（只新增列、放宽 kind 的取值，没有被替换的旧结构需要收缩）
-- migrate:up
-- 群里的 AI：每个 AI 在群里有一个席位，就是挂在群下面的一条会话（kind = 'seat'，parent_id 指向群）。
-- 席位用的是会话本来就有的 model_key、turn、last_run_id、permissions：它的一轮和私聊的一轮是同一套代码，
-- 只是消息写进群里。不新建表：席位的状态和私聊会话一模一样，另建一张表就是把这几列再抄一遍。
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check check (kind in ('dm', 'group', 'seat'));
alter table conversations add column parent_id uuid references conversations (id) on delete cascade;
-- 席位听到群里第几条消息了：下一轮把这之后的话交给它
alter table conversations add column heard_seq bigint not null default 0;
-- 群：光色、发言方式、分工方式；席位：在群里负责什么、什么时候被移出
alter table conversations add column options jsonb not null default '{}';
alter table conversations add constraint conversations_seat_check
  check (kind <> 'seat' or (model_key is not null and parent_id is not null));
-- 一个群里同一个 AI 只有一个席位
create unique index conversations_seat_once on conversations (parent_id, model_key) where kind = 'seat';

-- migrate:down
drop index conversations_seat_once;
delete from conversations where kind = 'seat';
alter table conversations drop constraint conversations_seat_check;
alter table conversations drop column options;
alter table conversations drop column heard_seq;
alter table conversations drop column parent_id;
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check check (kind in ('dm', 'group'));
