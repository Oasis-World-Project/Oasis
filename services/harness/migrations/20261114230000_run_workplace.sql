-- phase: expand
-- contract-plan: 不适用（可空的新列，空就是云端沙箱，没有旧结构需要收缩）
-- migrate:up
-- 在用户电脑上干活（第 5 阶段，2026-11-14）：一轮在哪跑——空是云端沙箱，否则是用户的哪台电脑、哪个
-- 项目文件夹。接着原会话、接管、清理工作目录、预览中间产物都按它找执行器（会话在那台电脑上）。
alter table runs add column workplace jsonb;

-- migrate:down
alter table runs drop column workplace;
