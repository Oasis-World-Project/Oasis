-- phase: expand
-- contract-plan: 不适用（只放宽调用类型的取值范围，没有旧结构需要收缩）
-- migrate:up
-- 调用记录多一种：工具（生图、配音、转写、联网搜索、网页抓取、Jev 判断……，ADR 0006）
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision', 'tool'));

-- migrate:down
delete from calls where kind = 'tool';
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in ('chat', 'decision'));
