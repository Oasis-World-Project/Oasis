-- phase: expand
-- contract-plan: 不适用（只新增列、放宽取值范围；旧数据全部仍然合法，没有旧结构需要收缩）
-- migrate:up
-- reworks：关卡退回修改过几次（最多 1 次，ADR 0004 §2）
alter table nodes add column reworks integer not null default 0;

-- 运行的用途增加：关卡退回后的修改、讨论里的发言、讨论的汇总
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check
  check (purpose in ('work', 'rework', 'speech', 'summary'));
-- 讨论发言的轮次和发言人 {round, participant}
alter table node_runs add column meta jsonb not null default '{}';
-- 交给 harness 的完整请求 {model, prompt, inputsFrom, continueFrom}：没送到时按原样重交
alter table node_runs add column request jsonb not null default '{}';

-- migrate:down
alter table node_runs drop column request;
alter table node_runs drop column meta;
alter table node_runs drop constraint node_runs_purpose_check;
alter table node_runs add constraint node_runs_purpose_check check (purpose in ('work'));
alter table nodes drop column reworks;
