-- phase: expand
-- contract-plan: 不适用（只放宽状态的取值范围，没有旧结构需要收缩）
-- migrate:up
-- 运行可以被用户「停止」：产出和会话都存下了，之后可以接着做
alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'stopped'));

-- migrate:down
update runs set status = 'cancelled' where status = 'stopped';
alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled'));
