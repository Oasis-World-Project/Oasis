# ADR 0001：MVP 的整体架构与技术栈

- 状态：已采纳（2026-10-21）
- 依据：PRD v0.2、`docs/engineering/项目工程方向.md`、`AGENTS.md`

## 背景

MVP 要跑通“建群 → 拉 AI → 发任务 → AI 分工 → 画布里改 → 定稿”。前期完全免费：新用户注册送 $30 额度，所有模型和工具调用都从额度里扣。

## 决定

| 事项 | 决定 |
|---|---|
| 语言 | 全 TypeScript，Node 24 LTS |
| 仓库 | pnpm workspaces + Turborepo 单仓 |
| 服务 | 9 个：gateway、identity、billing、agent、conversation、task、canvas、harness、model-gateway；每个独占数据库 |
| 通信 | 同步走内部 HTTP（Fastify + zod 契约），异步走 NATS JetStream；服务寻址走 Compose DNS + 环境变量，不上 Nacos |
| 存储 | PostgreSQL 18（每服务独立 database + 账号）、Valkey、SeaweedFS（S3 兼容） |
| 迁移 | Drizzle 写查询，dbmate 管迁移（纯 SQL，含 up/down），按 Expand→Migrate→Contract 执行 |
| 前端 | React 19 + Vite + TanStack Router/Query + Zustand；Tailwind v4 + 设计令牌 + Radix；Electron 壳 |
| 模型 | model-gateway 是唯一出口，OpenAI 兼容；MVP 先接 OpenRouter；dsh 的模型端点也指向它，方便统一计量 |
| Jev | 已有 API；藏在 conversation 的调度接口后面 |
| 登录 | 邮箱 + 验证码（本地用 Mailpit 收信） |
| 计费 | 以微美元整数记账；成本价 × 可配置系数（默认 1.0）；先预扣再结算；群里 AI 的消耗算群主；自带 Key 不扣额度 |
| 地区 | 先上海外 / 国际版 |

## 与《项目工程方向》不一致的地方

1. **dsh 的接入语言**：文档写“Python SDK 为主”。实际上 dsh 是基于 Cordis 的 TypeScript 运行时，Python SDK 只是通过 stdio JSON-RPC 驱动它，业务工具也要写成 TS 插件。所以 harness 服务直接用 TS 接入。
2. **本机操控**：任务属于群，必须在服务端执行。MVP 的 harness 只在服务端跑，每个任务一个隔离容器；桌面端先只是壳。
3. **对象存储**：原计划用 MinIO。MinIO 社区版从 2025-10 起不再发布镜像，2026 年仓库已归档，所以本地改用 SeaweedFS；上云后换成云厂商的 S3，只需改配置。
4. **PostgreSQL 版本**：讨论时说的是 17，实施时改用当前稳定的 18.6。

## 已知风险

- dsh 是 v0.2.x 开发者预览版：没有安全审计，headless 模式跑完就退出，没有 HTTP 服务，沙箱只限制写。对策：精确锁定版本，只在 Adapter 层接触，每个任务放进独立容器，任务 API 由 harness 服务自己提供。
