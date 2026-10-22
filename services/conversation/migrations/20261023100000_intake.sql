-- phase: expand
-- contract-plan: 不适用（新增带默认值的列和新表，旧消息都是普通文字，kind 默认 text 即正确值）
-- migrate:up
-- 消息有了类型：普通文字，或问题卡、任务单卡、任务卡、交付消息、任务提醒（ADR 0005 §7）；data 放卡片内容
alter table messages
  add column kind text not null default 'text'
    check (kind in ('text', 'questions', 'sheet', 'task', 'delivery', 'notice')),
  add column data jsonb not null default '{}';
-- 交付消息和任务提醒由 task 的事件触发：同一个事件只发一条（事件可能重复到达）
create unique index messages_event_once on messages ((data ->> 'eventId')) where data ? 'eventId';

-- 接需求：从认出任务到用户确认任务单的整个过程。不能放进 conversations / messages：
-- 它有自己的状态（在问 / 等确认 / 已确认 / 不做了）、轮数和问答记录，一个会话先后可以有很多次。
create table intakes (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  status text not null check (status in ('asking', 'sheet', 'confirmed', 'cancelled')),
  -- 已经问了几轮
  round integer not null default 0,
  -- 用户最初的需求，以及开始前最近几条聊天（给 AI 看上下文）
  request text not null,
  context jsonb not null default '[]',
  -- 之后的每一步：问题和回答、任务单、用户补充或修改的话
  turns jsonb not null default '[]',
  -- 当前这张还没处理的卡片（问题卡或任务单卡）
  card_message_id uuid,
  sheet jsonb,
  task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 一个会话同时只有一个进行中的接需求
create unique index intakes_one_open on intakes (conversation_id) where status in ('asking', 'sheet');

-- migrate:down
drop table intakes;
drop index messages_event_once;
alter table messages drop column data, drop column kind;
