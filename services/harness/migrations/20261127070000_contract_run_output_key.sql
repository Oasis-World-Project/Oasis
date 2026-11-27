-- phase: contract
-- migrate:up
-- 以前每轮把 out/ 打包存一份到对象存储，键记在 output_key；2026-11-26 起不再写（产出留在工作目录里，
-- 画布要哪个取哪个）。这一列删掉，harness 也不再连对象存储；对象存储里 oasis-harness 这个桶整个可以清掉。
alter table runs drop column output_key;

-- migrate:down
alter table runs add column output_key text;
