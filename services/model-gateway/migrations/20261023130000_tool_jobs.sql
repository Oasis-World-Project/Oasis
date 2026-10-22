-- phase: expand
-- contract-plan: 不适用（新建表，没有旧结构需要收缩）
-- migrate:up
-- 长任务（如生成视频，ADR 0006 §4）：先向供应商提交，之后由调用方来取结果。
-- 不能放进 calls：一次调用记录对应一次计量，这里要记住供应商的任务号和进度，取结果时才结算。
create table tool_jobs (
  id uuid primary key,
  tool text not null,
  provider_job_id text not null,
  status text not null check (status in ('pending', 'completed', 'failed')),
  -- 计量用的调用信息（冻结、付费人、任务和节点归属），结算或退回时要用
  call jsonb not null,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- migrate:down
drop table tool_jobs;
