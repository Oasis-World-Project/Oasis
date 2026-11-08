-- phase: expand
-- contract-plan: 不需要：只加可空列、放宽三处取值范围（节点种类、运行用途、节点名只在工作流里的节点之间不重复），旧代码读写不受影响。
-- migrate:up
-- 子节点（ADR 0026）：动态展开的每一条、做几版里的每一版都是一个节点，记下属于哪个节点、第几条 / 第几版。
alter table nodes
  add column parent_id uuid references nodes(id) on delete cascade,
  add column slot integer;
create index nodes_parent on nodes (parent_id) where parent_id is not null;
alter table nodes drop constraint nodes_kind_check;
alter table nodes add constraint nodes_kind_check check (kind in ('work', 'discussion', 'tool', 'foreach'));
-- 做几版挑一版时挑选的那次运行
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check
  check (purpose in ('work', 'rework', 'speech', 'summary', 'pick'));
-- 节点名只要在工作流里的节点之间不重复：移出工作流的节点（修改删掉的、重新展开换掉的）留着旧名字
alter table nodes drop constraint nodes_task_id_key_key;
create unique index nodes_task_key on nodes (task_id, key) where retired_version is null;

-- migrate:down
delete from node_runs where purpose = 'pick';
delete from nodes where parent_id is not null or kind = 'foreach';
drop index nodes_task_key;
alter table nodes add constraint nodes_task_id_key_key unique (task_id, key);
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check
  check (purpose in ('work', 'rework', 'speech', 'summary'));
alter table nodes drop constraint nodes_kind_check;
alter table nodes add constraint nodes_kind_check check (kind in ('work', 'discussion', 'tool'));
drop index nodes_parent;
alter table nodes drop column slot, drop column parent_id;
