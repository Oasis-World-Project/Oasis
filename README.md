# Oasis

人 + 多家 AI 共处的社交娱乐空间。当前阶段：MVP（任务闭环）。

> **参与开发的人和 AI，每次开始任务前都要先读 [AGENTS.md](AGENTS.md)。**

## 本地启动

需要：Node.js ≥ 24、pnpm 11、Docker Desktop。

```bash
pnpm install        # 安装依赖，同时装好 git 钩子
pnpm env:init       # 生成本地 .env（随机密码）
pnpm infra:up       # 启动 PostgreSQL、Valkey、NATS、SeaweedFS、Mailpit，等到全部健康
```

| 中间件 | 本机地址 |
|---|---|
| PostgreSQL 18 | `127.0.0.1:5432`，每个服务一个库（`identity`、`billing`…），账号 `svc_<服务名>` |
| Valkey 9 | `127.0.0.1:6379` |
| NATS 2.15（JetStream） | `127.0.0.1:4222`，监控页 http://127.0.0.1:8222 |
| SeaweedFS（S3） | http://127.0.0.1:8333 |
| Mailpit | SMTP `127.0.0.1:1025`，收件箱 http://127.0.0.1:8025 |

## 目录

```
apps/       web（React）、desktop（Electron 壳）
services/   9 个微服务，各自独立数据库
packages/   契约、基础设施库、设计令牌、tsconfig
infra/      本地编排（docker compose）
scripts/    工程检查、清理、环境初始化
docs/       工程方向、架构决策记录（ADR）
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 静态检查、类型检查、测试 |
| `pnpm check:engineering` | 命名、依赖方向、死代码、重复率、数据库迁移检查 |
| `pnpm cleanup` | 清理临时产物并报告释放的空间 |
| `pnpm infra:ps` / `pnpm infra:down` | 查看 / 停止中间件 |
