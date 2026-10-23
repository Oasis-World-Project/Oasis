-- phase: expand
-- contract-plan: 不适用（canvas 的第一张表，没有旧结构需要收缩）
-- migrate:up
-- 用户上传的素材（ADR 0007 §3）：文件本身在对象存储里，这里记是谁的、叫什么、多大
create table uploads (
  id uuid primary key,
  owner_id uuid not null,
  name text not null,
  size bigint not null check (size >= 0),
  content_type text not null,
  -- 对象存储里的键
  object_key text not null,
  created_at timestamptz not null default now()
);
create index uploads_owner on uploads (owner_id, created_at desc);

-- migrate:down
drop table uploads;
