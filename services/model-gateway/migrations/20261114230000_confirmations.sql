-- phase: expand
-- contract-plan: 不适用（全新的表和带默认值的新列，没有旧结构需要收缩）
-- migrate:up
-- 确认卡（第 5 阶段，2026-11-14）：一轮里要用户点的确认——AI 要做超出权限的事（dsh 插件登记），或要用
-- 花钱的工具（用户设了「问我」）。新表的原因：一轮可以有好几张，各有自己的状态和作答时间，调用记录和
-- 临时 Key 都放不下；按运行查，删对话时按临时 Key 上记的对话找到这些运行，一起删掉。
create table confirmations (
  id uuid primary key,
  run_id uuid not null,
  kind text not null check (kind in ('command', 'tool')),
  text text not null,
  call_id text,
  -- used：花钱的工具确认允许后已经拿去调了（一张只能用一次）
  status text not null default 'pending'
    check (status in ('pending', 'allowed', 'denied', 'cancelled', 'used')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index confirmations_run on confirmations (run_id, created_at);
-- 这一轮花钱的工具要先问（用户设了「问我」）；用户点过「以后都允许」的种类，这一轮里不再问
alter table run_keys
  add column ask_paid boolean not null default false,
  add column auto_allow text[] not null default '{}';

-- migrate:down
alter table run_keys drop column auto_allow, drop column ask_paid;
drop table confirmations;
