-- phase: expand
-- contract-plan: 不适用（可空的新列，空就是默认：云端沙箱、默认权限；没有旧结构需要收缩）
-- migrate:up
-- 在用户电脑上干活（第 5 阶段，2026-11-14）：每个私聊记着在哪干活（云端沙箱，或用户的哪台电脑、哪个项目
-- 文件夹）和权限（只读 / 可改项目文件夹 / 完全访问，超出时问不问，花钱的工具问不问），下一轮起用。
alter table conversations
  add column workplace jsonb,
  add column permissions jsonb;

-- migrate:down
alter table conversations drop column permissions, drop column workplace;
