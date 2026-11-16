-- phase: expand
-- contract-plan: 只放宽消息种类的约束，没有要收缩的旧结构
-- migrate:up
-- 群里的分工单是一条消息（kind = 'assign'）：谁把哪几部分交给了谁、各到哪了，进行中原地更新
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text', 'task', 'topic', 'assign'));

-- migrate:down
delete from messages where kind = 'assign';
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check check (kind in ('text', 'task', 'topic'));
