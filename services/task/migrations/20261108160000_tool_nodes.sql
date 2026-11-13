-- phase: expand
-- contract-plan: 不适用（只放宽节点种类的取值，旧数据都满足新约束）
-- migrate:up
-- 工具节点（kind = tool）不起 AI，在沙箱里按顺序执行工具步骤。
alter table nodes drop constraint nodes_kind_check;
alter table nodes add constraint nodes_kind_check check (kind in ('work', 'discussion', 'tool'));

-- migrate:down
-- 回退前须先删掉工具节点所在的任务（用户删除就是真删除），否则约束加不上
alter table nodes drop constraint nodes_kind_check;
alter table nodes add constraint nodes_kind_check check (kind in ('work', 'discussion'));
