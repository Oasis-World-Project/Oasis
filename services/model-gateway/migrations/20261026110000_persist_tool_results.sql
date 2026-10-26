-- phase: expand
-- contract-plan: 复用现有 tool_jobs，结果字段在完成后写入，旧 pending/completed 作业也经同一恢复流程补存。移除实时下载后直接返回 base64 的长任务路径；旧列仍用于任务归属与供应商追踪，无可删旧列。
-- migrate:up
alter table tool_jobs
  add column request_key uuid unique,
  add column request_hash text,
  add column phase text not null default 'pending',
  add column result jsonb,
  add column cost jsonb,
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column expires_at timestamptz;

-- migrate:down
alter table tool_jobs drop column expires_at, drop column lease_until, drop column lease_token, drop column cost, drop column result, drop column phase, drop column request_hash, drop column request_key;
