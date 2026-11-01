-- phase: expand
-- contract-plan: 不适用（新表，并放宽调用类型的取值范围，没有旧结构需要收缩）
-- migrate:up
-- 调用记录多一种：实时数字人（LiveAvatar 会话按实际消耗的积分计费，ADR 0013 §5）
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision', 'tool', 'compute', 'avatar'));

-- 实时数字人会话。新表的原因：会话有自己的生命周期（开始中、进行中、已结束）、在 LiveAvatar 上建的资源要清理、
-- 每轮问答要记下来给页面看；calls 表只记一次次调用。
-- spec：成果里的数字人配置（人设、知识要点、转人工），数字人入口每轮按它组织提示。
-- resources：在 LiveAvatar 上建的东西和临时 Key 的编号，边建边记，崩溃后清扫也能拆干净。
create table avatar_sessions (
  id uuid primary key,
  payer_id uuid not null,
  artifact_id uuid,
  task_id uuid,
  status text not null check (status in ('starting', 'live', 'ended')),
  sandbox boolean not null,
  max_seconds integer not null,
  price_per_minute_micro bigint not null,
  spec jsonb not null,
  resources jsonb not null default '{}'::jsonb,
  call_id uuid,
  turns jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  settled_at timestamptz,
  charged_micro bigint,
  cleaned_at timestamptz,
  created_at timestamptz not null default now()
);
create index avatar_sessions_payer on avatar_sessions (payer_id, created_at desc);
-- 清扫只看还没收尾的会话
create index avatar_sessions_open on avatar_sessions (created_at)
  where status <> 'ended' or settled_at is null or cleaned_at is null;

-- migrate:down
drop table avatar_sessions;
delete from calls where kind = 'avatar';
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision', 'tool', 'compute'));
