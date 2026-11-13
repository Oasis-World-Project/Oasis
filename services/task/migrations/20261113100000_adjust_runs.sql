-- phase: expand
-- contract-plan: 不需要：只放宽运行用途的取值范围，旧代码读写不受影响。
-- migrate:up
-- 中途调整（ADR 0030 §3.7）：做成果的 AI 提出调整后，规划员答复的那次运行记在提出的那样成果上
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check
  check (purpose in ('work', 'rework', 'speech', 'summary', 'pick', 'adjust'));

-- migrate:down
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check
  check (purpose in ('work', 'rework', 'speech', 'summary', 'pick'));
