-- phase: expand
-- contract-plan: 同一提交里的 20261114210100_contract_model_options 收掉 provider_model、version_label（默认就是可选型号里的第一个）
-- migrate:up
-- 每个 AI 可以换型号（2026-11-14，第 4 阶段）。options：可选的型号，第一个是默认（快速档）。每一项：
-- model 上游型号；label 给人看的名字；tier 档位（fast 快速 / balanced 均衡 / strong 强力 / max 最强，一个 AI 每档最多一个）；
-- inputPrice、outputPrice 大概单价（每百万 token 美元，按 11-14 的 OpenRouter 目录；DeepSeek 走官方，按官方实测）；
-- note 量过的结果或提醒。
alter table models add column options jsonb not null default '[]';
update models set options = '[
  {"model":"anthropic/claude-haiku-5.5","label":"Claude Haiku 5.5","tier":"fast","inputPrice":0.1,"outputPrice":0.5},
  {"model":"anthropic/claude-sonnet-5.5","label":"Claude Sonnet 5.5","tier":"balanced","inputPrice":2,"outputPrice":10},
  {"model":"anthropic/claude-opus-5.5","label":"Claude Opus 5.5","tier":"strong","inputPrice":4,"outputPrice":20},
  {"model":"anthropic/claude-fable-5.2","label":"Claude Fable 5.2","tier":"max","inputPrice":8,"outputPrice":40}
]' where key = 'claude';
update models set options = '[
  {"model":"openai/gpt-6-luna","label":"GPT-6 Luna","tier":"fast","inputPrice":0.1,"outputPrice":0.5},
  {"model":"openai/gpt-6.1-terra","label":"GPT-6.1 Terra","tier":"balanced","inputPrice":1,"outputPrice":5},
  {"model":"openai/gpt-6.1-sol-pro","label":"GPT-6.1 Sol Pro","tier":"strong","inputPrice":2,"outputPrice":10},
  {"model":"openai/gpt-6-astra-pro","label":"GPT-6 Astra Pro","tier":"max","inputPrice":10,"outputPrice":50,"note":"慢"}
]' where key = 'gpt';
update models set options = '[
  {"model":"google/gemini-3.5-flash-lite","label":"Gemini 3.5 Flash-Lite","tier":"fast","inputPrice":0.3,"outputPrice":2.5},
  {"model":"google/gemini-3.8-flash","label":"Gemini 3.8 Flash","tier":"balanced","inputPrice":0.83,"outputPrice":4.13},
  {"model":"google/gemini-4-argon","label":"Gemini 4 Argon","tier":"strong","inputPrice":2,"outputPrice":10}
]' where key = 'gemini';
update models set options = '[
  {"model":"x-ai/grok-4.3","label":"Grok 4.3","tier":"fast","inputPrice":1.25,"outputPrice":2.5},
  {"model":"x-ai/grok-4.7","label":"Grok 4.7","tier":"strong","inputPrice":2,"outputPrice":6}
]' where key = 'grok';
update models set options = '[
  {"model":"meta-llama/llama-4-maverick","label":"Llama 4 Maverick","tier":"fast","inputPrice":0.35,"outputPrice":1}
]' where key = 'llama';
update models set options = '[
  {"model":"qwen/qwen3.8-flash","label":"Qwen3.8 Flash","tier":"fast","inputPrice":0.15,"outputPrice":0.47},
  {"model":"qwen/qwen3.8-max-prime","label":"Qwen3.8 Max Prime","tier":"strong","inputPrice":4,"outputPrice":12}
]' where key = 'qwen';
update models set options = '[
  {"model":"mistralai/mistral-small-2603","label":"Mistral Small 4","tier":"fast","inputPrice":0.15,"outputPrice":0.6},
  {"model":"mistralai/mistral-large-4-0","label":"Mistral Large 4","tier":"strong","inputPrice":0.7,"outputPrice":2.1}
]' where key = 'mistral';
update models set options = '[
  {"model":"moonshotai/kimi-k2.5","label":"Kimi K2.5","tier":"fast","inputPrice":0.5,"outputPrice":2.5},
  {"model":"moonshotai/kimi-k3.1-pro","label":"Kimi K3.1 Pro","tier":"strong","inputPrice":2,"outputPrice":10}
]' where key = 'kimi';
update models set options = '[
  {"model":"minimax/minimax-m3.1-flash","label":"MiniMax M3.1 Flash","tier":"fast","inputPrice":0.15,"outputPrice":0.6},
  {"model":"minimax/minimax-m3","label":"MiniMax M3","tier":"strong","inputPrice":0.3,"outputPrice":1.2}
]' where key = 'minimax';
update models set options = '[
  {"model":"z-ai/glm-5.3-flash","label":"GLM-5.3 Flash","tier":"fast","inputPrice":0.04,"outputPrice":0.08},
  {"model":"z-ai/glm-5.3-prime","label":"GLM-5.3 Prime","tier":"strong","inputPrice":2.8,"outputPrice":8.8}
]' where key = 'glm';
update models set options = '[
  {"model":"deepseek/deepseek-v4.1-flash","label":"DeepSeek V4.1 Flash","tier":"fast","inputPrice":0.15,"outputPrice":0.6},
  {"model":"deepseek/deepseek-v4-pro","label":"DeepSeek V4 Pro","tier":"strong","inputPrice":0.9,"outputPrice":1.5}
]' where key = 'deepseek';
update models set options = '[
  {"model":"tencent/hy3","label":"混元 Hy3","tier":"fast","inputPrice":0.13,"outputPrice":0.53},
  {"model":"tencent/hy4","label":"混元 Hy4","tier":"strong","inputPrice":0.42,"outputPrice":1.25}
]' where key = 'hunyuan';
-- 用户给各个 AI 选的档位（AI 的 key → 档位）；没选的用默认（第一个）。存档位不存型号：以后换了型号，选的档位照旧
alter table user_ai_settings add column tiers jsonb not null default '{}';

-- migrate:down
alter table user_ai_settings drop column tiers;
alter table models drop column options;
