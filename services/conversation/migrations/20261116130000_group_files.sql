-- phase: expand
-- contract-plan: 只加新表和新序列，没有要收缩的旧结构
-- migrate:up
-- 群文件：AI 交的（canvas 里席位名下的成果）和人传的（canvas 里的上传文件），一个群里同一个路径只有一份。
-- 再交、再传同一个路径就是新版本：这一行改指向新的那份，rev 往后走。
create sequence group_files_rev;
create table group_files (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references conversations (id) on delete cascade,
  path text not null check (length(path) between 1 and 500),
  name text not null,
  size bigint not null,
  -- 这一版内容的记号：sha256，没有时是大小
  version text not null,
  source text not null check (source in ('artifact', 'upload')),
  -- canvas 里的成果 ID 或上传文件 ID，和它在 canvas 里是谁名下的
  ref_id uuid not null,
  ref_owner uuid not null,
  -- 最早是谁做的、谁传的；现在这一版是谁交的（AI 的 key 或用户 ID）
  made_kind text not null check (made_kind in ('ai', 'user')),
  made_by text not null,
  changed_kind text not null check (changed_kind in ('ai', 'user')),
  changed_by text not null,
  -- 现在这一版是 AI 的哪一轮交的
  run_id uuid,
  rev bigint not null,
  -- 每个来源（artifact:ID、upload:ID）已经算过的那一版：同一版再登记一遍不算新版本
  seen jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, path)
);
create index group_files_rev_idx on group_files (group_id, rev);

-- migrate:down
drop table group_files;
drop sequence group_files_rev;
