-- phase: contract
-- migrate:up
-- 会话包续跑删除（阶段 1，2026-11-08）：接着原会话只靠持久工作目录（ADR 0015 §9），对象存储只存产出，
-- 每次运行结束不再上传 runs/<id>/session.tar。工作目录不在了由 task 改成重新做、带上上一版产出（ADR 0022）。
-- 开发库里旧的会话包对象随环境重建一起清掉（用户确认旧数据不保留）。
alter table runs drop column session_key;

-- migrate:down
alter table runs add column session_key text;
