-- phase: expand
-- contract-plan: 新增可空校验信息，不替代旧字段。历史文件保持 null，新流式写入保存 SHA-256；没有双写或旧列需要删除。
-- migrate:up
alter table uploads add column sha256 text check (sha256 ~ '^[a-f0-9]{64}$'), add column state text not null default 'ready' check (state in ('uploading', 'ready'));
alter table artifacts add column sha256 text check (sha256 ~ '^[a-f0-9]{64}$');

-- migrate:down
alter table artifacts drop column sha256;
alter table uploads drop column sha256;
alter table uploads drop column state;
