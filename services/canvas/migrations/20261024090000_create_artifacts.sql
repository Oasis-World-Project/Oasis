-- phase: expand
-- contract-plan: 不适用（新表，没有旧结构需要收缩）
-- migrate:up
-- 画布里的成果（ADR 0007 §8）：任务完成时，负责交付物的节点交出的文件复制进画布，一个文件一行。
-- 不放进 uploads：素材是用户给的输入，成果是 AI 交出的产出，来源、字段和以后的用法（批注、替换新版、同步到电脑）都不同。
create table artifacts (
  id uuid primary key,
  owner_id uuid not null,
  task_id uuid not null,
  task_title text not null,
  conversation_id uuid,
  node_id uuid not null,
  -- 节点产出里的相对路径
  path text not null,
  name text not null,
  deliverable text not null,
  size bigint not null check (size >= 0),
  content_type text not null,
  category text not null check (category in ('doc', 'media', 'threed', 'app', 'data')),
  -- 做它的模型（供应商型号）
  models jsonb not null default '[]',
  object_key text not null,
  -- 同步到电脑时相对同步文件夹的路径（同一个用户里不重复）
  sync_path text not null,
  created_at timestamptz not null default now()
);
-- 同一个文件只登记一次（任务完成的事件可能重复到达）
create unique index artifacts_once on artifacts (task_id, node_id, path);
create unique index artifacts_sync_path on artifacts (owner_id, sync_path);
create index artifacts_owner on artifacts (owner_id, created_at desc);

-- migrate:down
drop table artifacts;
