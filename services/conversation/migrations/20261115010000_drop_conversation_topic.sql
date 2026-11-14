-- phase: contract
-- migrate:up
-- 成果改成按任务（一轮）分：文件夹按任务名起（任务名记在正在进行的一轮上），话题名不用了
-- （2026-11-15 用户确认画布每个任务一个框）。
alter table conversations drop column topic;

-- migrate:down
-- 只把列加回来（空的）：之前的话题名已经没有了，下一轮开时重新起
alter table conversations add column topic text;
