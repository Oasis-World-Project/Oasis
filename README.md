# Oasis

人 + 多家 AI 共处的社交娱乐空间。当前阶段：MVP（任务闭环）。

> **参与开发的人和 AI，每次开始任务前都要先读 [AGENTS.md](AGENTS.md)。**

## 本地启动

需要：Node.js ≥ 24、pnpm 11、Docker Desktop。

```bash
pnpm install        # 安装依赖，同时装好 git 钩子
pnpm env:init       # 生成根目录和每个服务的 .env（随机密码）
pnpm infra:up       # 启动 PostgreSQL、Valkey、NATS、SeaweedFS、Mailpit，等到全部健康
pnpm dev            # 9 个服务 + Web 端在本机运行，改代码自动重启 / 热更新
pnpm desktop        # （可选）另开一个终端，打开 Electron 桌面窗口
```

打开 http://127.0.0.1:5173 就是 Web 端；gateway 在 http://127.0.0.1:8080 。

停止：在跑 `pnpm dev` 的终端按 `Ctrl + C`（服务会优雅退出）；中间件用 `pnpm infra:down` 停掉，数据保留在 Docker 数据卷里，下次 `pnpm infra:up` 接着用。

> 第一次运行 `pnpm desktop` 会下载 Electron 程序（约 100 MB，下载后会校验 SHA-256）。如果从 GitHub 下载很慢，可以临时用镜像：PowerShell 里先执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 再运行。

### 登录与接入模型

- **登录**：打开 Web 端，输入任意邮箱获取验证码。本地不会真的发邮件，验证码在 Mailpit 收件箱 http://127.0.0.1:8025 里看。新邮箱第一次登录即注册，几秒内到账 $30 额度。
- **接入模型**：在 `services/model-gateway/.env` 里填上 `OPENROUTER_API_KEY=sk-or-...`，然后重启 `pnpm dev`。这个文件不进 git，Key 不要贴到聊天或提交里。没填 Key 时页面能正常打开，发消息会提示「模型服务还没有配置好」。
- **地区限制**：OpenRouter 按发出请求的网络判断地区。部分模型（目前是 Claude、GPT、Gemini）在一些地区用不了，界面会提示「这个 AI 在当前网络所在的地区用不了」，这次调用不扣钱。换到这些模型支持的网络，或者部署到海外服务器上就能用。
- **计费**：每次调用先冻结一笔预估金额，完成后按 OpenRouter 报告的实际花费 × `BILLING_PRICE_MULTIPLIER`（billing 的配置，默认 1.0）扣除，多冻结的部分退回。规则见 [ADR 0002](docs/adr/0002-auth-billing-chat-loop.md)。

### Agent 运行（harness）

每次 agent 运行，harness 都会通过本机 Docker 起一个沙箱容器，里面跑精确锁定版本的 DeepSeek Harness（dsh）。第一次用之前先构建沙箱镜像（约 1.7 GB，含 Python 和中文字体；需要能访问 npm 和 Debian 软件源）：

```bash
pnpm sandbox:build
```

- 沙箱容器在内部网络 `oasis-sandbox` 里，**不通外网**，只能访问 `pnpm infra:up` 起的两个代理：
  - 入口代理 `sandbox-ingress`：只放行「调模型」「Jev 决策」「工具」（沙箱里的 `oasis-tool` 命令：生图、视频、配音、转写、联网搜索……）几条路径，转给 model-gateway 的 `/run/v1/*`，凭每次运行专用的临时 Key 计费。
  - 出口代理 `sandbox-egress`：只放行软件包仓库，让节点里的 AI 能 `npm install`、`pip install`。仓库地址和放行的域名在根目录 `.env`（`SANDBOX_NPM_REGISTRY`、`SANDBOX_PIP_INDEX_URL`、`SANDBOX_EGRESS_ALLOW_HOSTS`）：开发机在国内，默认用国内镜像站；部署到海外后换回官方源。
  - 访问其他任何地址都会失败。设计见 [ADR 0006](docs/adr/0006-tools-and-capability-gateway.md)。
- 算力按沙箱运行时长 × CPU 核数计费（model-gateway 的 `COMPUTE_PRICE_MICRO_PER_CORE_HOUR`，默认每核每小时 $0.015；设为 0 就不计费）。
- 本机开发时 model-gateway 跑在宿主机上，入口代理经 `host.docker.internal:4108` 访问它。Docker Desktop（Windows / macOS）上默认配置就能通（2026-10-22 在 Windows 上实测）；在 Linux 宿主机上要把 `services/model-gateway/.env` 里的 `HOST` 改成 `0.0.0.0`（这会让局域网也能访问 4108，只在自己电脑上这样做）。
- harness 的 `/ready` 会检查 Docker、沙箱镜像和网络是否都在。设计见 [ADR 0003](docs/adr/0003-task-workflow.md)。

需要在容器里跑全套做集成验证时：`pnpm stack:up`（构建 9 个服务镜像并启动，全部健康才返回），`pnpm infra:down` 全部停掉。

## 服务

| 服务 | 端口 | 职责 | 对外 |
|---|---|---|---|
| gateway | 8080 | 唯一对外入口：`/api/<服务>/v1/*` → `<服务>/v1/*` | ✅ |
| identity | 4101 | 账号与登录（邮箱验证码） | 经 gateway |
| billing | 4102 | 额度钱包：注册送 $30、预扣与结算、用量 | 经 gateway |
| agent | 4103 | 模型目录、AI 人设、自带 Key | 经 gateway |
| conversation | 4104 | 群聊与私聊、@、发言方式、Jev 调度 | 经 gateway |
| task | 4105 | 任务、工作流、节点状态机 | 经 gateway |
| canvas | 4106 | 成果、批注、文件 | 经 gateway |
| harness | 4107 | Agent 运行时（唯一接触 DeepSeek Harness） | 仅内部 |
| model-gateway | 4108 | 所有模型调用的唯一出口，计量上报 billing | 仅内部 |

每个服务都有 `/health`（进程存活）、`/ready`（依赖可用）、`/v1/meta`（服务名、版本、提交号）。业务接口放在 `/v1/*`，只给服务之间调用的放在 `/internal/*`（gateway 不转发）。

所有镜像都在本地构建，统一命名为 `oasis/<组件>:<标签>`（规则见 AGENTS.md B.10）。

| 中间件 | 本机地址 |
|---|---|
| PostgreSQL 18 | `127.0.0.1:5432`，每个服务一个库（`identity`、`billing`…），账号 `svc_<服务名>` |
| Valkey 9 | `127.0.0.1:6379` |
| NATS 2.15（JetStream） | `127.0.0.1:4222`，监控页 http://127.0.0.1:8222 |
| SeaweedFS（S3） | http://127.0.0.1:8333 |
| Mailpit | SMTP `127.0.0.1:1025`，收件箱 http://127.0.0.1:8025 |
| 沙箱入口代理、出口代理 | 只在内部网络 `oasis-sandbox` 里，宿主机访问不到 |

## 目录

```
apps/       web（React 19 + Vite + TanStack Router + Tailwind v4）、desktop（Electron 壳）
services/   9 个微服务，各自独立数据库
packages/   contracts（契约）、service-kit（服务启动底座）、design-tokens（设计令牌）、tsconfig
infra/      本地编排（docker compose）
scripts/    工程检查、清理、环境初始化
docs/       工程方向、架构决策记录（ADR）
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 静态检查、类型检查、测试 |
| `pnpm check:engineering` | 命名、镜像命名、设计令牌、依赖方向、死代码、重复率、数据库迁移检查 |
| `pnpm cleanup` | 清理临时产物并报告释放的空间 |
| `pnpm infra:ps` / `pnpm infra:down` | 查看 / 停止全部容器 |
| `pnpm sandbox:build` | 构建 agent 沙箱镜像（dsh 版本锁定在镜像标签里） |
| `pnpm stack:up` / `pnpm stack:logs` | 容器里跑全套 / 看日志 |
