-- phase: expand
-- contract-plan: 不适用（只新增可空列和部分索引，没有被替换的旧结构需要收缩）
-- migrate:up
-- 真删除（2026-11-05 用户要求）：上传的文件被消息、批注用上时记下认领时间；
-- 一直没被用上的上传（添加后又移除、没发出去）24 小时后由清扫删除对象和记录，不长期占用存储
alter table uploads add column claimed_at timestamptz;
-- 已有的文件都当作已认领，不误删
update uploads set claimed_at = created_at where state = 'ready';
create index uploads_unclaimed on uploads (created_at) where claimed_at is null;

-- migrate:down
drop index if exists uploads_unclaimed;
alter table uploads drop column claimed_at;
