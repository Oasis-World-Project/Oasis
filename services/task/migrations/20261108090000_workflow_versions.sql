-- phase: expand
-- contract-plan: 不适用（只新增带默认值的列和新表；旧任务就是第 1 版、没有进行中的修改，即正确值）
-- migrate:up
-- ADR 0022：修改交给规划员，工作流分版本，先确认再跑。
-- version：当前是第几版；revision：进行中的修改（规划中 / 待确认），没有时为空
alter table tasks add column version integer not null default 1;
alter table tasks add column revision jsonb;
-- 修改方案里删掉的节点不真删（运行记录随节点级联删除），记下从第几版起不在工作流里，旧版还能查看它的运行过程
alter table nodes add column retired_version integer;

-- 确认修改时把当前工作流冻结成一个版本（只读查看用）
create table workflow_versions (
  task_id uuid not null references tasks (id) on delete cascade,
  version integer not null,
  -- 这一版是按哪条修改意见做出来的；第 1 版为空
  request text,
  nodes jsonb not null,
  edges jsonb not null,
  deliverables jsonb not null default '[]',
  spent_micro bigint not null default 0,
  created_at timestamptz not null,
  frozen_at timestamptz not null default now(),
  primary key (task_id, version)
);

-- migrate:down
drop table workflow_versions;
alter table nodes drop column retired_version;
alter table tasks drop column revision;
alter table tasks drop column version;
