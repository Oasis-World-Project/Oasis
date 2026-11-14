-- phase: contract
-- migrate:up
-- 撤掉需求整理和 task 服务后的收缩（第 2 阶段，用户 11-14 确认清空全部旧数据之后）：没有接需求的记录，
-- 没有按 task 事件发的交付消息和提醒，没有上下文摘要（dsh 自己压缩）；消息只剩文字、任务卡和开新话题。
drop table intakes;
drop index if exists messages_event_once;
alter table conversations drop column context_summary;
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check check (kind in ('text', 'task', 'topic'));

-- migrate:down
-- 回退把表、列和索引建回来（空的）：旧数据清空时已经没了
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text', 'questions', 'sheet', 'task', 'delivery', 'notice', 'topic'));
alter table conversations add column context_summary jsonb;
create unique index messages_event_once on messages ((data ->> 'eventId')) where data ? 'eventId';
create table intakes (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  status text not null check (status in ('asking', 'sheet', 'confirmed', 'cancelled')),
  round integer not null default 0,
  request text not null,
  context jsonb not null default '[]',
  turns jsonb not null default '[]',
  card_message_id uuid,
  sheet jsonb,
  task_id uuid,
  materials jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index intakes_one_open on intakes (conversation_id) where status in ('asking', 'sheet');
