-- phase: expand
-- contract-plan: 不适用（只新增可空列，没有旧结构需要收缩）
-- migrate:up
-- session_id：这次运行用的 dsh 会话（全新运行就是自己的 ID；接着原会话的运行沿用上一次的会话）
-- continue_from：接着哪一次运行的会话和工作区（关卡退回修改、停止后继续、讨论的下一轮）
alter table runs
  add column session_id text,
  add column continue_from uuid;

-- migrate:down
alter table runs
  drop column continue_from,
  drop column session_id;
