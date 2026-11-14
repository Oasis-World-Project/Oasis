-- phase: contract
-- migrate:up
-- 默认型号就是 options 里的第一个，不再单独存（第 4 阶段，2026-11-14）
alter table models drop column provider_model;
alter table models drop column version_label;

-- migrate:down
alter table models add column provider_model text;
alter table models add column version_label text;
update models set provider_model = options -> 0 ->> 'model', version_label = options -> 0 ->> 'label';
