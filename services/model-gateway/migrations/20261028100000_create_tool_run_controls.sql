-- phase: expand
-- contract-plan: Permanent cancellation admission state; no legacy columns or dual-write path to remove. Rollback requires draining all pending tool jobs first.
-- migrate:up
create table tool_run_controls (
  run_id uuid primary key,
  payer_id uuid not null,
  task_id uuid,
  cancelled_at timestamptz
);
create unique index tool_jobs_bill_line on tool_jobs ((call->'billingEvidence'->>'billId')) where call->'billingEvidence'->>'billId' is not null;
-- migrate:down
drop index tool_jobs_bill_line;
drop table tool_run_controls;
