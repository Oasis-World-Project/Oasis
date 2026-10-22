-- phase: expand
-- contract-plan: 不适用（harness 的第一批表，没有旧结构需要收缩）
-- migrate:up
-- 一次 agent 运行 = 一个沙箱容器里的一个 dsh 会话（ADR 0003 §5–6）
create table runs (
  id uuid primary key,
  payer_id uuid not null,
  task_id uuid,
  node_id uuid,
  model text not null,
  -- 交给 agent 的完整任务说明（审计、排查用）
  prompt text not null,
  status text not null check (status in ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled')),
  error text,
  container_id text,
  run_key_id uuid,
  -- 产出文件清单 [{path, size}]，文件本身打成 tar 存在对象存储的 output_key
  outputs jsonb not null default '[]',
  output_key text,
  -- dsh 会话存档（互审打回重做、崩溃恢复时接着原上下文）
  session_key text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index runs_task_node on runs (task_id, node_id) where task_id is not null;
create index runs_unfinished on runs (created_at) where status in ('queued', 'starting', 'running');

-- 运行过程中的事件（已翻译成 Oasis 的事件，节点详情里展示）
create table run_events (
  run_id uuid not null references runs (id) on delete cascade,
  seq integer not null,
  kind text not null check (kind in ('status', 'user_message', 'assistant_text', 'tool_call', 'tool_result', 'turn_end', 'error')),
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

-- 事务发件箱（service-kit 的 startOutboxRelay 负责投递）
create table outbox (
  id uuid primary key,
  subject text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (created_at) where published_at is null;

-- migrate:down
drop table outbox;
drop table run_events;
drop table runs;
