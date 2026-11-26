-- phase: expand
-- contract-plan: 不适用（只加两个可空的列，没有旧结构需要收缩）
-- migrate:up
-- 每次模型调用记下 OpenRouter 转给了哪家（同一型号有好几家在跑，各家的表现不一样）和发出去的消息有多少字符。
-- 两样对着 prompt_tokens 看，就知道哪家把内容弄丢了：2026-11-26 Kimi K2.5 在 Amazon Bedrock 上不把工具结果
-- 交给模型，一轮空转了 83 次调用，当时没记是哪家，查了很久。
alter table calls add column provider text;
alter table calls add column input_chars integer;

-- migrate:down
alter table calls drop column input_chars;
alter table calls drop column provider;
