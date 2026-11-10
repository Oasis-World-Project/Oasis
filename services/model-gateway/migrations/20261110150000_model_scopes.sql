-- phase: expand
-- contract-plan: Permanent per-user setting (ADR 0027); no legacy columns or dual-write path to remove. Existing tables are per call / per run, none is keyed by user.
-- migrate:up
create table model_scopes (
  user_id uuid primary key,
  domestic_only boolean not null,
  updated_at timestamptz not null default now()
);
-- migrate:down
drop table model_scopes;
