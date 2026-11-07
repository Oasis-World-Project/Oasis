-- phase: migrate
-- migrate:up
-- 旧记录原样搬进 check_browsers：没停好的浏览器由新代码照常停掉、结算（expired 只是到时停止，归为 stopped）
insert into check_browsers (
  id, payer_id, task_id, status, container_id, compute_call_id,
  held_micro, spent_micro, started_at, stopped_at, error, created_at
)
select
  id, owner_id, task_id,
  case when status = 'expired' then 'stopped' else status end,
  container_id, compute_call_id, held_micro, spent_micro, started_at, stopped_at, error, created_at
from preview_sessions
on conflict (id) do nothing;

-- migrate:down
-- 回滚时旧表仍在（expand 的 down 删掉新表），搬过去的记录无需搬回
select 1;
