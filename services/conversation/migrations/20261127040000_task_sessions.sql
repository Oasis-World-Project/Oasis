-- phase: expand
-- contract-plan: 不适用（只多收一种会话，没有旧结构要收缩）
-- migrate:up
-- 云端任务有自己的会话（用户 2026-11-26 定）：kind = 'task' 的一行，挂在群或和 AI 的私聊下面（parent_id），
-- 一个任务一行——群里「作为任务发布」、分工单的一项、私聊「在云端做」；改这个任务就接着这一行做。
-- options.room 记它挂在哪种房间下面（'group' 花群的金库，'dm' 花主人的钱包）。
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('dm', 'group', 'seat', 'direct', 'task'));
create index conversations_running_tasks on conversations (parent_id) where kind = 'task' and turn is not null;

-- migrate:down
drop index conversations_running_tasks;
delete from conversations where kind = 'task';
alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check
  check (kind in ('dm', 'group', 'seat', 'direct'));
