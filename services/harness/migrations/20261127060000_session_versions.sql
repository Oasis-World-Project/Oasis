-- phase: expand
-- contract-plan: 不适用（新增的表，没有被替换的旧结构需要收缩）
-- migrate:up
-- 会话记录存一份在我们这边：每轮结束时把 dsh 的会话记录（不含它引用的附件）存一版，记在这一轮上。
-- 一份会话只留最近几版：撤回最后一句时退回上一版，留几版就能连着撤几轮。
-- 不放在 runs 上：每次读运行都会把这一大块带出来。运行删掉时跟着删。
create table session_versions (
  run_id uuid primary key references runs (id) on delete cascade,
  session_id text not null,
  -- tar 包：sessions/<dsh 按工作目录起的目录>/<会话 ID>/session.*，解到 dsh 的用户目录下
  archive bytea not null,
  -- 撤回了后面那一轮：下一轮新起 dsh 之前先把这一版放回去
  restore boolean not null default false,
  created_at timestamptz not null default now()
);
create index session_versions_session on session_versions (session_id);

-- migrate:down
drop table session_versions;
