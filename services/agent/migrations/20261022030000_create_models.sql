-- phase: expand
-- contract-plan: 不适用（全新的表，没有旧结构需要收缩）
-- migrate:up
-- 模型目录。provider_model 为空表示还不能用（显示「即将接入」）。
-- 默认版本按用户选定的「省钱档」（2026-10-22，OpenRouter 上每家最便宜、仍能正常对话的版本）。
create table models (
  key text primary key,
  name text not null,
  vendor text not null,
  category text not null check (category in ('llm', 'image', 'vision', 'video', 'audio', 'embedding', '3d', 'other')),
  tags text[] not null default '{}',
  mono text not null,
  glow text not null,
  provider_model text,
  version_label text,
  sort_order integer not null,
  created_at timestamptz not null default now()
);

insert into models (key, name, vendor, category, tags, mono, glow, provider_model, version_label, sort_order) values
  ('claude', 'Claude', 'Anthropic', 'llm', array['长文写作', '写代码']::text[], 'Cl', '#F0A07C', 'anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 10),
  ('gpt', 'GPT', 'OpenAI', 'llm', array['全能通用', '多模态']::text[], 'GPT', '#6FD0AE', 'openai/gpt-6-luna', 'GPT Luna', 20),
  ('gemini', 'Gemini', 'Google', 'llm', array['超长上下文', '看图看视频']::text[], 'Ge', '#8FB2FF', 'google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 30),
  ('grok', 'Grok', 'xAI', 'llm', array['实时资讯', '说话直接']::text[], 'Gk', '#9A9DB2', 'x-ai/grok-4.3', 'Grok 4.3', 40),
  ('llama', 'Llama', 'Meta', 'llm', array['开源', '可本地部署']::text[], 'Ll', '#7FB7E8', 'meta-llama/llama-4-maverick', 'Llama 4 Maverick', 50),
  ('qwen', 'Qwen', '阿里巴巴', 'llm', array['中文强', '开源']::text[], 'Qw', '#9C8CFF', 'qwen/qwen3.8-flash', 'Qwen3.8 Flash', 60),
  ('mistral', 'Mistral', 'Mistral AI', 'llm', array['开源轻量', '欧洲多语言']::text[], 'Mi', '#FFB36B', 'mistralai/mistral-small-2603', 'Mistral Small', 70),
  ('ernie', '文心一言', '百度', 'llm', array['中文知识', '百度生态']::text[], '文心', '#6F8BFF', null, null, 80),
  ('kimi', 'Kimi', '月之暗面', 'llm', array['长文档阅读', '联网搜索']::text[], 'Ki', '#A3A3B0', 'moonshotai/kimi-k2.5', 'Kimi K2.5', 90),
  ('minimax', 'MiniMax', 'MiniMax', 'llm', array['角色扮演', '语音自然']::text[], 'MM', '#FF8FB1', 'minimax/minimax-m3', 'MiniMax M3', 100),
  ('glm', 'GLM', '智谱', 'llm', array['智能体', '工具调用']::text[], 'GLM', '#8C9BFF', 'z-ai/glm-5.3-flash', 'GLM-5.3 Flash', 110),
  ('deepseek', 'DeepSeek', '深度求索', 'llm', array['深度推理', '性价比']::text[], 'DS', '#6E95FF', 'deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 120),
  ('spark', '讯飞星火', '科大讯飞', 'llm', array['语音交互', '教育办公']::text[], '星火', '#5FC3E4', null, null, 130),
  ('hunyuan', '混元', '腾讯', 'llm', array['中文创作', '腾讯生态']::text[], '混元', '#64B5F6', 'tencent/hy3', '混元 3', 140);

-- migrate:down
drop table models;
