# Oasis

人 + 多家 AI 共处的社交娱乐空间。当前阶段：MVP（任务闭环）。

> **参与开发的人和 AI，每次开始任务前都要先读 [AGENTS.md](AGENTS.md)。**

## 本地启动

需要：Node.js ≥ 24、pnpm 11、Docker Desktop。

```bash
pnpm install        # 安装依赖，同时装好 git 钩子
pnpm env:init       # 生成根目录和每个服务的 .env（随机密码）
pnpm infra:up       # 启动 PostgreSQL、NATS、SeaweedFS、Mailpit，等到全部健康
pnpm dev            # 9 个服务 + 前端开发服务器在本机运行，改代码自动重启 / 热更新
pnpm desktop        # 另开一个终端，打开 Electron 桌面窗口（产品以桌面端为准）
```

产品以桌面窗口为准；http://127.0.0.1:5173 用浏览器也能打开，只保证能用。gateway 在 http://127.0.0.1:8080 。

停止：在跑 `pnpm dev` 的终端按 `Ctrl + C`（服务会优雅退出）；中间件用 `pnpm infra:down` 停掉，数据保留在 Docker 数据卷里，下次 `pnpm infra:up` 接着用。

> 第一次运行 `pnpm desktop` 会下载 Electron 程序（约 100 MB，下载后会校验 SHA-256）。如果从 GitHub 下载很慢，可以临时用镜像：PowerShell 里先执行 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` 再运行。

### 打 Windows 安装包

```powershell
$env:OASIS_RELEASE_WEB_URL = 'https://<线上的网址>'   # 装好的桌面版打开的网址，写进安装包里
pnpm desktop:dist                                       # 只能在 Windows 上跑；安装包在 apps/desktop/release/
```

安装包（NSIS，约 200 MB，装好约 900 MB、两万五千个文件，安装要三四分钟）装到当前用户名下，不要管理员权限；自带 Node 和 dsh，「在我的电脑上干活」不用用户另装东西。没有签名（安装时 Windows 会提示「未知发布者」），不带自动更新。第一次打包要下载 Node（校验 SHA-256）、装 dsh（约 2 分钟），每次打包压缩约 10 分钟；下载慢时可以设 `OASIS_NODE_DIST`、`ELECTRON_BUILDER_BINARIES_MIRROR` 指到镜像站。

### 登录与接入模型

- **登录**：打开 Web 端，输入任意邮箱获取验证码。本地不会真的发邮件，验证码在 Mailpit 收件箱 http://127.0.0.1:8025 里看。新邮箱第一次登录即注册，几秒内到账 $30 额度。
- **接入模型**：在 `services/model-gateway/.env` 里填上 `OPENROUTER_API_KEY=sk-or-...`，然后重启 `pnpm dev`。这个文件不进 git，Key 不要贴到聊天或提交里。没填 Key 时页面能正常打开，发消息会提示「模型服务还没有配置好」。
- **地区限制**：OpenRouter 按发出请求的网络判断地区。部分模型（目前是 Claude、GPT、Gemini）在一些地区用不了，界面会提示「这个 AI 在当前网络所在的地区用不了」，这次调用不扣钱。换到这些模型支持的网络，或者部署到海外服务器上就能用。
- **计费**：每次调用先冻结一笔预估金额，完成后按 OpenRouter 报告的实际花费 × `BILLING_PRICE_MULTIPLIER`（billing 的配置，默认 1.0）扣除，多冻结的部分退回。规则见 [账号与计费](docs/design/账号与计费.md)。

### Agent 运行（harness）

私聊里的每一轮，harness 都会通过本机 Docker 起一个沙箱容器，里面跑精确锁定版本的 DeepSeek Harness（dsh）。第一次用之前先构建沙箱镜像（含 Python 文档/数据处理库、LibreOffice、ffmpeg、PDF 工具、中文字体，Chromium 和 playwright-core，以及 git、pandoc、sqlite3、jq、ImageMagick、sox、ripgrep、esbuild、TypeScript 等命令行工具；需要能访问 npm、Debian 和配置的 Python 软件源）：

```bash
pnpm sandbox:build
pnpm sandbox:build:3d
pnpm sandbox:check
```

- `sandbox:check` 在断网、2 核、2 GB 的临时容器中验证文档转换、中文提取、公式重算、软件清单、命令行工具和浏览器（打开本地页面、按键、读页面状态、WebGL、截图），不调用模型；退出后删除测试文件和容器。预装 Python 库在独立环境里，直接运行 `python3` / `pip` 即可使用；预装的 Node 包在 `/node_modules`，任何目录下的脚本都能直接 `import`。
- 构建时 Python 软件源读取根目录 `.env` 的 `SANDBOX_PIP_INDEX_URL`，通过 BuildKit secret 传入；未配置则使用 pip 默认源。系统软件从 Debian 的快照源装（Dockerfile 里的 `DEBIAN_SNAPSHOT` 日期），同一个日期装到的版本永远一样；要拿安全更新就把日期往前挪、重新构建、跑 `sandbox:check`。快照源只在国外，根目录 `.env` 里配了 `SANDBOX_APT_MIRROR`（国内镜像站）时，镜像站上有同一个版本的包就从镜像站下，版本仍以快照为准，造出来的镜像和不配镜像站时一样。电脑开着系统代理时，Docker Desktop 会让构建里的下载也走代理，国内镜像站反而变慢（2026-11-19 在开发机上量：构建里约 50 kB/s，同一时刻主机上不走代理约 10 MB/s）；那次是在主机上临时起一个直连的转发代理，构建时用 `--build-arg HTTPS_PROXY=…` 经它出去的。软件精确版本见 `services/harness/sandbox/requirements.txt` 和 Dockerfile，`oasis-tool list` 会显示构建时实际安装的软件版本。
- 沙箱容器在内部网络 `oasis-sandbox` 里，**不通外网**，只能访问 `pnpm infra:up` 起的两个代理：
  - 入口代理 `sandbox-ingress`：只放行「调模型」「Jev 决策」「工具」（沙箱里的 `oasis-tool` 命令：生图、视频、配音、转写、联网搜索……）几条路径，转给 model-gateway 的 `/run/v1/*`，凭每一轮专用的临时 Key 计费。
  - 出口代理 `sandbox-egress`：只放行软件包仓库，让沙箱里的 AI 能 `npm install`、`pip install`。仓库地址和放行的域名在根目录 `.env`（`SANDBOX_NPM_REGISTRY`、`SANDBOX_PIP_INDEX_URL`、`SANDBOX_EGRESS_ALLOW_HOSTS`）：开发机在国内，默认用国内镜像站；部署到海外后换回官方源。
  - 访问其他任何地址都会失败。设计见 [工具与沙箱](docs/design/工具与沙箱.md)。
- 算力按沙箱运行时长 × CPU 核数计费（model-gateway 的 `COMPUTE_PRICE_MICRO_PER_CORE_HOUR`，默认每核每小时 $0.015；设为 0 就不计费）。
- 本机开发时 model-gateway 跑在宿主机上，入口代理经 `host.docker.internal:4108` 访问它。Docker Desktop（Windows / macOS）上默认配置就能通（2026-10-22 在 Windows 上实测）；在 Linux 宿主机上要把 `services/model-gateway/.env` 里的 `HOST` 改成 `0.0.0.0`（这会让局域网也能访问 4108，只在自己电脑上这样做）。
- harness 的 `/ready` 会检查 Docker、沙箱镜像和网络是否都在。设计见 [工具与沙箱](docs/design/工具与沙箱.md)。
- 在你的电脑上干活：私聊右上角选「我的电脑」和一个项目文件夹（要在桌面版里选），这个私聊的每一轮就在那台电脑上跑 dsh，不起沙箱。那台电脑要开着桌面版（登录同一个账号），装好 Node 24（或 22.19 以上的 22 版）；第一次干活时桌面版自己装 dsh（约 3 分钟）。权限和确认卡见 [私聊与一轮](docs/design/私聊与一轮.md) §7。
- `pnpm dev` 中 harness 使用稳定进程，不随源码变动自动重启；修改它后手动重启开发服务。重启会接管原运行和原生会话，`/workspace` 与会话目录保留在带 Oasis 标签的 named volume 中，删私聊、开新话题时一起清理。项目依赖装进工作目录（如 `.venv`、`node_modules`），不要修改镜像内的系统环境来保存状态。接管依赖暂不可用时保留进度等待恢复，用户停止/取消意图优先处理；详见 [私聊与一轮](docs/design/私聊与一轮.md)。

### 检查（inspector）

判断成果的检查都在 inspector：文件解析、音视频解码、网页的浏览器检查（AI 自查用的 `oasis-tool app.check`、外站测试 `website.test`）、模型预览。它不调别的服务、不存东西，要检查的内容由调用方给对象存储的临时下载链接，或直接放在请求里。

- 音视频解码在不联网、限核的检查容器里做，用沙箱基础镜像（`pnpm sandbox:build`）。
- 网页的浏览器检查在检查浏览器容器里做（Playwright + Chromium，应用和浏览器同容器、无外部网络），第一次用之前构建镜像，可以顺手烟测一遍（不花钱）：

```bash
pnpm browser:build
pnpm browser:smoke
```

- 检查容器的算力记在发起它的那一轮上（model-gateway 冻结、按 inspector 报回的实际用时结算）。容器用完即删，inspector 断开时检查浏览器跟着退出。
- 外站测试只访问 inspector 的 `WEBSITE_TEST_ORIGINS` 里放行的 HTTPS 来源，默认为空（关闭）。

需要在容器里跑全套做集成验证时：`pnpm stack:up`（构建 9 个服务镜像并启动，全部健康才返回），`pnpm infra:down` 全部停掉。线上就是这样跑的，再加一个入口容器，见 `docs/ops/部署.md`。

## 服务

| 服务 | 端口 | 职责 | 对外 |
|---|---|---|---|
| gateway | 8080 | 唯一对外入口：`/api/<服务>/v1/*` → `<服务>/v1/*`；另有桌面版连 harness 的 WebSocket 和电脑上的 dsh 调模型、工具的 `/api/run/v1/*` | ✅ |
| identity | 4101 | 账号与登录（邮箱验证码） | 经 gateway |
| billing | 4102 | 额度钱包：注册送 $30、预扣与结算、用量 | 经 gateway |
| agent | 4103 | 「AI 们」（型号清单里的对话 AI 和工具型号）、人设和型号路由、用户的设置（只用国内模型、每个 AI 用哪一档、名字和人格） | 经 gateway |
| conversation | 4104 | 私聊（一轮：开、跟进、插话、停止、收尾）、群聊 | 经 gateway |
| canvas | 4106 | 成果、批注、文件 | 经 gateway |
| harness | 4107 | 私聊 AI 的运行时：每一轮在沙箱或用户的电脑上跑 dsh（唯一接触 DeepSeek Harness） | 仅内部（桌面版经 gateway 连上来） |
| model-gateway | 4108 | 所有模型调用的唯一出口，计量上报 billing | 仅内部 |
| inspector | 4109 | 检查成果：文件解析、音视频解码、网页的浏览器检查、外站测试、模型预览（不调别的服务、不存东西） | 仅内部 |
| model-gateway（数字人入口） | 4118 | 只有 `/avatar/v1/chat/completions`，给 LiveAvatar 回调大模型；开发期经 `pnpm avatar:tunnel` 和服务器 nginx 暴露为 `https://oasis-dev.elysiumgrid.space/avatar/v1` | 只这一条路径公网可达 |

每个服务都有 `/health`（进程存活）、`/ready`（依赖可用）、`/v1/meta`（服务名、版本、提交号）。业务接口放在 `/v1/*`，只给服务之间调用的放在 `/internal/*`（gateway 不转发）。

所有镜像都在本地构建，统一命名为 `oasis/<组件>:<标签>`（规则见 AGENTS.md B.10）。

| 中间件 | 本机地址 |
|---|---|
| PostgreSQL 18 | `127.0.0.1:5432`，每个服务一个库（`identity`、`billing`…），账号 `svc_<服务名>` |
| NATS 2.15（JetStream） | `127.0.0.1:4222`，监控页 http://127.0.0.1:8222 |
| SeaweedFS（S3） | http://127.0.0.1:8333 |
| Mailpit | SMTP `127.0.0.1:1025`，收件箱 http://127.0.0.1:8025 |
| 沙箱入口代理、出口代理 | 只在内部网络 `oasis-sandbox` 里，宿主机访问不到 |

## 目录

```
apps/       web（React 19 + Vite + TanStack Router + Tailwind v4）、desktop（Electron 壳）
services/   9 个微服务，各自独立数据库（inspector 不用数据库）
packages/   contracts（契约）、service-kit（服务启动底座）、design-tokens（设计令牌）、tsconfig
infra/      本地编排（docker compose）
scripts/    工程检查、清理、环境初始化
docs/       工程方向、现在是怎么做的（design）、回归测试
```

## CI

`.github/workflows/ci.yml`（GitHub Actions）只做两件事：

- 每次推上去：`pnpm format:check`、`pnpm lint`、`pnpm check:engineering`、`pnpm typecheck`、`pnpm test`。要连数据库、要 Docker 镜像的测试在 CI 里自动跳过，`pnpm e2e` 也不在 CI 里，这些在本地跑。
- 手动点（GitHub 的 Actions 页 → CI → Run workflow，填上线上的网址）：检查过了以后再打一个 Windows 安装包，在这次运行的 Artifacts 里下载（留 14 天）。

部署不在 CI 里：在服务器上拉代码、构建镜像，见 `docs/ops/`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 静态检查、类型检查、测试 |
| `pnpm check:engineering` | 命名、镜像命名、设计令牌、依赖方向、死代码、重复率、数据库迁移检查 |
| `pnpm models:check` | 型号清单（`packages/contracts/src/lineup.ts`）对着 OpenRouter 目录核对：下架的、标价变了的、同一家新出的；`--probe` 试调对话 AI 的型号 |
| `pnpm e2e` | 全链路回归（假模型、真容器、真画布，先停 `pnpm dev`）；`--real` 用真模型跑 5 个场景，每场景 ≤ $1（小游戏 `real-game` ≤ $3）。见 `docs/engineering/回归测试.md` |
| `pnpm trace <对话 ID>` | 查一个私聊每一轮的运行、调用、费用来源和画布成果，并标出异常 |
| `pnpm accept` | 验收模式：服务从当前代码启动、不随改动重启，Web 用构建版 |
| `pnpm cleanup` | 清理临时产物并报告释放的空间 |
| `pnpm infra:ps` / `pnpm infra:down` | 查看 / 停止全部容器 |
| `pnpm sandbox:build` | 构建 agent 沙箱镜像（dsh 版本锁定在镜像标签里） |
| `pnpm sandbox:check` | 在断网、2 核、2 GB 临时容器中验收文档转换、公式重算和软件清单，不调用模型 |
| `pnpm sandbox:check:ops` | 离线验收沙箱里的本地操作 `oasis-op`（拼接、截取、抽帧、配音轨、转格式），不调用模型 |
| `pnpm media:smoke` / `pnpm video:smoke` | 免费验证大文件传输 / 视频剪辑、MLT 渲染、工程移动与打包；均不调用模型供应商 |
| `pnpm model:smoke` | 免费验证真实 WebGL、图片/视频降级和生产 Electron 壳；自动构建相关服务，使用内存数据与隔离配置，不调用云。需已有沙箱基础镜像；`--serve` 留下本地 Web 验证页 |
| `pnpm stack:up` / `pnpm stack:logs` | 容器里跑全套 / 看日志 |
