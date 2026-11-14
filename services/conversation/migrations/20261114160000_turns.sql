-- phase: expand
-- contract-plan: 清空旧数据后（第 2 阶段，用户确认）删 intakes 表、messages_event_once 索引和 conversations.context_summary 列；messages.kind 只留 text、task、topic
-- migrate:up
-- 撤掉需求整理和 task 服务（2026-11-14）：私聊里的 AI 就是干活的主 AI，用户说一句开一轮（harness 的一次运行）。
-- turn：正在进行的一轮（运行编号、已经写进消息的事件序号、正在写的 AI 消息、任务卡）；没有为 null。
alter table conversations add column turn jsonb;
-- 当前会话最近的一轮：下一轮接着它的会话做（AI 记得之前的事）；开新话题后为 null
alter table conversations add column last_run_id uuid;
-- 当前话题的名字（这个话题第一句话的开头）：成果在电脑上按它放文件夹
alter table conversations add column topic text;
-- 服务重启后要接着跟进的对话
create index conversations_active_turn on conversations (id) where turn is not null;
-- 新的消息种类：开新话题的分隔
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text', 'questions', 'sheet', 'task', 'delivery', 'notice', 'topic'));

-- migrate:down
delete from messages where kind = 'topic';
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text', 'questions', 'sheet', 'task', 'delivery', 'notice'));
drop index conversations_active_turn;
alter table conversations drop column topic;
alter table conversations drop column last_run_id;
alter table conversations drop column turn;
