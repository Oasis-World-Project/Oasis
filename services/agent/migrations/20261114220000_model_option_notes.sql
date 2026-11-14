-- phase: migrate
-- migrate:up
-- 第 4 阶段实测（2026-11-14，开发机）：同一个私聊里先让它做一个计数小网页放进 out/ 并自己检查，再说「你好」。
-- 说明里写做小网页的用时和花费（一次的结果，波动不小）；「你好」都在 4–8 秒，不写。
-- 自己看不了图的（目录里只收文字）也写上；Llama 4 Maverick 在 Oasis 里不调工具，标「做任务较弱」。
-- Claude、GPT、Gemini 在开发机所在地区用不了（OpenRouter 403），上线到海外后再量。
with notes(model, note) as (
  values
    ('deepseek/deepseek-v4.1-flash', '实测：小网页 6.5 分钟、$0.04（检查得很细）'),
    ('deepseek/deepseek-v4-pro', '实测：小网页 47 秒、$0.02；自己看不了图'),
    ('qwen/qwen3.8-flash', '实测：小网页 62 秒、不到 $0.01'),
    ('qwen/qwen3.8-max-prime', '实测：小网页 52 秒、$0.19'),
    ('moonshotai/kimi-k2.5', '实测：小网页 63 秒、$0.04'),
    ('moonshotai/kimi-k3.1-pro', '实测：小网页 68 秒、$0.12'),
    ('z-ai/glm-5.3-flash', '实测：小网页 29 秒、不到 $0.01'),
    ('z-ai/glm-5.3-prime', '实测：小网页 40 秒、$0.12；自己看不了图'),
    ('minimax/minimax-m3.1-flash', '实测：小网页 3.2 分钟、$0.01'),
    ('minimax/minimax-m3', '实测：小网页 1.8 分钟、$0.03'),
    ('tencent/hy3', '实测：小网页 2.8 分钟、$0.01；自己看不了图'),
    ('tencent/hy4', '实测：小网页 3.1 分钟、$0.05'),
    ('x-ai/grok-4.3', '实测：小网页 53 秒、$0.04'),
    ('x-ai/grok-4.7', '实测：小网页 4 分钟、$0.29'),
    ('mistralai/mistral-small-2603', '实测：小网页 55 秒、不到 $0.01'),
    ('mistralai/mistral-large-4-0', '实测：小网页 48 秒、$0.03'),
    ('meta-llama/llama-4-maverick', '做任务较弱：实测没调工具、没交出文件，适合聊天')
)
update models m
set options = (
  select jsonb_agg(
    case when n.note is null then o else o || jsonb_build_object('note', n.note) end
    order by i
  )
  from jsonb_array_elements(m.options) with ordinality as e(o, i)
  left join notes n on n.model = o ->> 'model'
)
where exists (
  select 1 from jsonb_array_elements(m.options) o join notes n on n.model = o ->> 'model'
);

-- migrate:down
update models m
set options = (
  select jsonb_agg(
    case when o ->> 'note' like '实测：%' or o ->> 'note' like '做任务较弱：%' then o - 'note' else o end
    order by i
  )
  from jsonb_array_elements(m.options) with ordinality as e(o, i)
)
where jsonb_array_length(m.options) > 0;
