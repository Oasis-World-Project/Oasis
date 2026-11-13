-- phase: expand
-- contract-plan: 不适用（只加两个可空的列，没有旧结构需要收缩）
-- migrate:up
-- 每次聊天调用的输入里，有多少是读的缓存、有多少是这次写进缓存的（OpenRouter 用量里的
-- prompt_tokens_details）。用来看缓存到底有没有起作用：同一个会话的后续调用，读缓存的应该占大头。
alter table calls add column cached_tokens integer;
alter table calls add column cache_write_tokens integer;

-- migrate:down
alter table calls drop column cache_write_tokens;
alter table calls drop column cached_tokens;
