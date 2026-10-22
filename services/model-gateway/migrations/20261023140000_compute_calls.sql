-- phase: expand
-- contract-plan: 不适用（只放宽调用类型的取值范围，没有旧结构需要收缩）
-- migrate:up
-- 调用记录多一种：算力（沙箱容器按运行时长 × 核数计费，ADR 0006 §6）
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision', 'tool', 'compute'));

-- migrate:down
delete from calls where kind = 'compute';
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision', 'tool'));
