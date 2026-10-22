-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
-- 每次 agent 运行专用的临时 Key：沙箱里的 dsh 用它调模型，钱记在付费人名下。
-- 新表的原因：这是一个独立的新概念（有自己的有效期和作废状态），现有的 calls 表记录的是调用，不是凭证。
-- 明文 Key 只在签发时返回一次，这里只存 sha256。
create table run_keys (
  id uuid primary key,
  key_hash text not null unique,
  payer_id uuid not null,
  run_id uuid not null,
  task_id uuid,
  node_id uuid,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index run_keys_run on run_keys (run_id);

-- migrate:down
drop table run_keys;
