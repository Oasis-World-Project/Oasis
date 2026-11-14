-- phase: expand
-- contract-plan: 清空旧数据后（第 2 阶段，用户确认）删 task_id、task_title、node_id、deliverable 和 artifacts_once 索引，conversation_id、session_id、run_id、topic 改成 not null
-- migrate:up
-- 撤掉 task 服务（2026-11-14）：成果跟着对话走。对话里每一轮结束时，out/ 里新增和改过的文件登记进画布；
-- 同一个话题（同一个会话，开新话题就是新的）里同一路径只有一份成果，后来的一轮改了它就原地换成新版。
alter table artifacts alter column task_id drop not null;
alter table artifacts alter column task_title drop not null;
alter table artifacts alter column node_id drop not null;
alter table artifacts alter column deliverable drop not null;
alter table artifacts add column session_id uuid;
alter table artifacts add column run_id uuid;
-- 话题名：这个话题的成果在电脑上放在同名文件夹里
alter table artifacts add column topic text;
create unique index artifacts_session_path on artifacts (session_id, path);
create index artifacts_conversation on artifacts (conversation_id);

-- migrate:down
drop index artifacts_conversation;
drop index artifacts_session_path;
-- 新流程登记的成果没有任务，回到旧结构前删掉（对象由清扫或手工清理）
delete from artifacts where task_id is null;
alter table artifacts drop column topic;
alter table artifacts drop column run_id;
alter table artifacts drop column session_id;
alter table artifacts alter column deliverable set not null;
alter table artifacts alter column node_id set not null;
alter table artifacts alter column task_title set not null;
alter table artifacts alter column task_id set not null;
