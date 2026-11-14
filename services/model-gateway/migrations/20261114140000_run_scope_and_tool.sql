-- phase: expand
-- contract-plan: 清空旧数据后（第 2 阶段，用户确认）删 model_scopes 表：「只用国内模型」存在 agent，开一轮时随临时 Key 带来
-- migrate:up
-- 「只用国内模型」挪到 agent（2026-11-14）：开一轮时随临时 Key 带来，这一轮的工具只给国内厂商的型号。
alter table run_keys add column domestic_only boolean not null default false;
-- 调用记录写上是哪个工具：一轮用过生图、视频这类工具就算任务
alter table calls add column tool text;

-- migrate:down
alter table calls drop column tool;
alter table run_keys drop column domestic_only;
