-- phase: expand
-- contract-plan: 不适用（只新增可空列，没有被它替代的旧结构；旧会话没有摘要，按整段对话拼上下文即正确）
-- migrate:up
-- 私聊较早部分的摘要（ADR 0016 §8）：快到模型上下文窗口时才生成，through_seq 之前的消息由它代替
alter table conversations add column context_summary jsonb;

-- migrate:down
alter table conversations drop column context_summary;
