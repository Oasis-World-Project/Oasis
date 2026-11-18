-- phase: expand
-- contract-plan: 不适用（只放宽事件种类的取值范围，没有旧结构需要收缩）
-- migrate:up
-- AI 列的待办（todos 事件）要存得进来：契约里早就有这一种，表上的取值范围漏了它，
-- 一写就整批失败——同一批里别的事件也跟着丢（2026-11-19 真模型跑群任务时在日志里看到）。
alter table run_events drop constraint run_events_kind_check;
alter table run_events add constraint run_events_kind_check
  check (kind in ('status', 'user_message', 'assistant_text', 'tool_call', 'tool_result', 'todos', 'turn_end', 'error'));

-- migrate:down
delete from run_events where kind = 'todos';
alter table run_events drop constraint run_events_kind_check;
alter table run_events add constraint run_events_kind_check
  check (kind in ('status', 'user_message', 'assistant_text', 'tool_call', 'tool_result', 'turn_end', 'error'));
