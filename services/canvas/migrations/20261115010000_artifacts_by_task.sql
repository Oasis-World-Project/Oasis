-- phase: contract
-- migrate:up
-- 画布按任务（一轮）分：成果上记的是那一轮的任务名，不再是话题名（2026-11-15 用户确认画布每个任务一个框）。
-- 改名要和新代码一起上；旧数据里存的话题名照旧当任务名用。
alter table artifacts rename column topic to task;

-- migrate:down
alter table artifacts rename column task to topic;
