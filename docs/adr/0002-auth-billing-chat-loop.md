# ADR 0002：登录、额度与私聊闭环

- 状态：已采纳（2026-10-22，第四阶段）
- 范围：identity、billing、agent、model-gateway、conversation、gateway、Web

## 背景

第四阶段要跑通：邮箱验证码注册 → 到账 $30 → 和一个 AI 私聊（流式输出）→ 按实际花费扣费。

## 决定

### 登录与会话

- 邮箱验证码：6 位数字，10 分钟有效；同一邮箱 60 秒内只能发一次、每小时最多 5 次；每个验证码最多试 5 次。验证码只存 HMAC（密钥 `AUTH_CODE_PEPPER`，并绑定邮箱），比较用常数时间。
- 第一次验证即注册。验证码核销、建用户、写 outbox 事件、建会话在同一个事务里完成。
- 会话令牌是 32 字节随机数，库里只存 sha256；默认 30 天，最多每小时续一次。
- 只用 Cookie `oasis_session`（httpOnly、SameSite=Lax；`COOKIE_SECURE` 本地为 false，线上必须为 true）。前端拿不到令牌。
- gateway 负责鉴权：调用 identity 的 `/internal/sessions/introspect`，结果按令牌哈希缓存 30 秒（`SESSION_CACHE_TTL_MS`）。所以退出登录后，旧 Cookie 最晚 30 秒失效。这是有意的取舍。
- gateway 先删掉客户端传来的所有 `x-oasis-*` 头，再写入 `x-oasis-user-id`。Cookie 只转发给 identity。
- CSRF：写请求（非 GET/HEAD/OPTIONS）的 `Origin` 必须在 `GATEWAY_ALLOWED_ORIGINS` 里，否则返回 403。
- 登录后的跳转地址只接受站内路径。`//x` 和 `/\x` 会被浏览器当成别的站，一律拒绝。

### 额度与计费

- 金额一律用微美元整数（1 USD = 1,000,000）。
- 注册送额度：identity 写 outbox → NATS JetStream `identity.user.registered` → billing 的持久消费者发放 `SIGNUP_GRANT_MICRO`（默认 30,000,000）。
  - 有三层去重：消息 ID 去重（2 分钟窗口）、`processed_events` 表、账本上的唯一索引（每个用户只能发一次 signup 额度）。
  - 钱包还没建好时，`/v1/wallet` 返回 404 `wallet_not_ready`，前端稍等重试。
- 每次模型调用都分三步：冻结 → 调用 → 结算或退回。
  - 冻结金额按价格表和 `max_tokens` 估算，查不到价格时用 `FALLBACK_HOLD_MICRO`。余额不够返回 402 `insufficient_balance`。
  - 结算按实际花费，优先级：OpenRouter 返回的 `usage.cost` > token 数 × 价格表 > 按字数估算。每次调用都记下用的是哪一种（`cost_source`）。
  - 实际扣费 = 花费 × `BILLING_PRICE_MULTIPLIER`（默认 1.0），向上取整到微美元。超出余额的部分记为未收回，不会扣成负数。
  - 失败就退回冻结；进程中途崩溃时，冻结超过 `HOLD_TTL_MS` 由清扫任务自动退回。
- 谁付钱由调用方在 `x-oasis-payer-id` 里指明。私聊由会话的主人付；以后群里的 AI 消耗由群主付。

### 模型与私聊

- agent 维护模型目录：14 个对话 AI，默认「省钱档」型号。
  - 文心、讯飞星火在 OpenRouter 上没有，标为暂不可用，前端显示「即将接入」。
  - 前端只看得到 `key`，看不到真实的供应商型号（`providerModel`）。
- model-gateway 对内提供 OpenAI 兼容的 `/internal/v1/chat/completions`，请求转发给 OpenRouter。
  - 流式时自动加 `stream_options.include_usage`，读取最后一段里的用量。
  - 客户端断开时取消上游请求；已生成的部分仍按实际花费结算。
- conversation 的 `POST /v1/conversations/:id/messages` 返回 SSE。事件顺序是 `accepted` → 多个 `delta` → `done`；出错时最后一个事件是 `error`。
  - 浏览器断开后服务端继续生成并保存回复。失败的回复会存下原因和已生成的部分。
  - 带最近 `HISTORY_LIMIT` 条消息作为上下文。

### 事件可靠性

- 发布事件一律走 transactional outbox。业务事务里写 `outbox` 表，中继每 500ms 把未发的事件发到 JetStream，消息 ID 用事件 ID。
- 消费者都是持久消费者，手动 ack，失败 5 秒后重投，最多投 20 次，并且都要幂等（`processed_events`）。

## 后果

- 新增密钥 `AUTH_CODE_PEPPER`：由 `pnpm env:init` 生成，换掉它会让所有未用的验证码失效。
- OpenRouter Key 只放在 `services/model-gateway/.env`（`OPENROUTER_API_KEY`），不进 git，也不出现在日志里。没有 Key 时模型调用返回 503 `provider_not_configured`。
- Turborepo 用严格环境变量模式：`pnpm dev` 只把 `.env` 文件里的配置交给服务，在终端里临时 `set` 的变量不会传进去。本地临时覆盖配置要用 `pnpm turbo run dev --env-mode=loose`。
