-- phase: expand
-- contract-plan: 不适用（task 的第一批表，没有旧结构需要收缩）
-- migrate:up
-- 任务 = 一张工作流图（ADR 0004）。金额都是微美元整数。
create table tasks (
  id uuid primary key,
  owner_id uuid not null,
  payer_id uuid not null,
  conversation_id uuid,
  title text not null,
  -- 任务单摘要，交给每个节点
  brief text not null,
  status text not null check (status in ('running', 'stopped', 'needs_attention', 'succeeded', 'failed', 'cancelled')),
  -- 需要用户处理时的原因 {reason, nodeId, message}
  attention jsonb,
  estimate_micro bigint,
  spent_micro bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index tasks_owner_created on tasks (owner_id, created_at desc);

create table nodes (
  id uuid primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  key text not null,
  title text not null,
  kind text not null check (kind in ('work', 'discussion')),
  role text not null default '',
  goal text not null,
  model text not null,
  -- 讨论参与者、验收点等（5.2b）
  config jsonb not null default '{}',
  status text not null check (status in ('waiting', 'running', 'checking', 'succeeded', 'failed', 'stopped', 'blocked', 'cancelled')),
  -- 已经跑了几次（含重做）
  attempts integer not null default 0,
  -- 用户在节点开跑前追加的要求 ["..."]
  user_notes jsonb not null default '[]',
  warning text,
  -- 最近一次成功运行的结果：AI 最后一句话、产出清单
  summary text,
  outputs jsonb not null default '[]',
  current_run_id uuid,
  spent_micro bigint not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (task_id, key)
);

-- 连线：任一端可以是空的（删了节点留下断口），所以用 on delete set null
create table edges (
  id uuid primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  from_node_id uuid references nodes (id) on delete set null,
  to_node_id uuid references nodes (id) on delete set null
);
create index edges_task on edges (task_id);

-- 节点的每一次运行（id 就是 harness 的运行 ID）。pending = 已写库、还没确认 harness 收到
create table node_runs (
  id uuid primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  node_id uuid not null references nodes (id) on delete cascade,
  attempt integer not null,
  purpose text not null check (purpose in ('work')),
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  summary text,
  error text,
  outputs jsonb not null default '[]',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index node_runs_active on node_runs (created_at) where status in ('pending', 'running');

-- migrate:down
drop table node_runs;
drop table edges;
drop table nodes;
drop table tasks;
