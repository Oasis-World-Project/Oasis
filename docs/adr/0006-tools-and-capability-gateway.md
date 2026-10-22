# ADR 0006：工具目录与能力网关（5.4）

- 状态：已采纳（2026-10-23）
- 依据：ADR 0003 第 6–8 节、ADR 0005、用户 2026-10-23 的决定（多模态先走 OpenRouter、联网搜索用 Tavily、算力按成本价、开发机走国内镜像站）
- 范围：agent、model-gateway、harness、task、billing、沙箱镜像与入口 / 出口代理

## 背景

5.3 试用时，任务单里有一张「首屏效果图（PNG）」，没有任何节点交得出来：节点里的 AI 只会写字、写代码、跑命令，没有生图、联网、配音这些能力。5.6–5.10 的场景（图片、视频、音频、深度研究、营销……）都依赖外部工具。5.4 要做的是：**让 AI 团队能用上外部工具，并且每一次使用都经过网关、计量、计费、计入任务花费。**

## 决定

### 1. 工具目录（model-gateway）

工具目录由 model-gateway 提供（`GET /internal/v1/tools`），定义写在代码里、和供应商适配放在一起（`src/service/tools.ts`）：一个工具的名字、参数、调用方式和计费是一体的，放进 agent 的表里反而要两处同步（5.4a 实现时定，原草案写的是 agent）。一个工具 = 一种能力：

| 字段 | 说明 |
|---|---|
| key | 稳定的名字，如 `image.generate`、`video.generate`、`audio.speech`、`audio.transcribe`、`web.search`、`web.fetch`、`jev.decide` |
| 名称、说明、用法 | 给规划员和节点里的 AI 看（普通话 + 命令示例） |
| 供应商 | `openrouter` / `tavily` / `oasis`（Jev） |
| 可选模型 | 例如生图可以用哪几个 OpenRouter 模型、默认哪个；没有的为空 |
| 计费单位 | 张 / 秒 / 次 / token；能拿到供应商实际花费的按实际花费，拿不到的按目录单价 |
| 长任务 | 要等几十秒到几分钟的（视频） |
| 可用 | 没配 Key 的工具自动不可用，规划员看不到 |

第一批（5.4 接入并实测）：`image.generate`、`video.generate`、`audio.speech`、`audio.transcribe`（都走 OpenRouter）、`web.search`、`web.fetch`（Tavily）、`jev.decide`（Jev）。3D、音乐等 OpenRouter 没有的，到 5.8 / 5.9 再接 fal.ai，方式相同。

### 2. 节点里的 AI 怎么用工具：一个命令行程序

- 沙箱镜像里装一个 `oasis-tool` 命令（源码 `services/harness/sandbox/oasis-tool.ts`，Node 直接运行 TypeScript，只用 Node 自带的能力）。AI 用它已有的「运行命令」能力调用，例如：
  `oasis-tool image.generate --prompt "……" --size 1920x1080 --out out/首屏效果图.png`
- 不写 dsh 插件：工具和 dsh 解耦，换掉 dsh 也照样能用（「dsh 是可拆装的底座」）。
- `oasis-tool` 只能连入口代理，带着本次运行的临时 Key；入口代理多放行一条路径 `/v1/tools/*`，转给 model-gateway。沙箱仍然碰不到任何服务的 `/internal`，也不直接连外网。
- dsh 运行命令时会去掉名字像密钥的环境变量（名字里有 KEY、PASSWORD、SECRET、TOKEN），`OASIS_RUN_KEY` 到不了命令里。这把临时 Key 本来就是给这次运行里的 AI 用的（只能调模型和工具，花费记在这次运行上，运行结束即作废），所以 harness 另用 `OASIS_TOOL_AUTH` 再给一份，`oasis-tool` 读它（5.4 联调时发现）。
- 生成的文件（图片、音频、视频）由 model-gateway 取回，原样传给 `oasis-tool`，写到 AI 指定的位置。

### 3. 能力网关（model-gateway）

- 新增 `/run/v1/tools/:key`（沙箱用，临时 Key 鉴权）和 `/internal/v1/tools/:key`（内部服务用）。
- 每次调用和模型调用一样：冻结额度 → 调供应商 → 按实际花费（或目录单价 × 数量）结算 → 记调用记录（多一种 `kind = tool`）→ 属于任务的调用发 `model-gateway.call.settled`，task 照常累加花费、检查上限。
- 地区不可用的模型照样会被记录并自动排除（5.3 的机制对工具模型同样有效）。
- 供应商的 Key 只在 model-gateway：`OPENROUTER_API_KEY`（已有）、`TAVILY_API_KEY`（新增，用户填进本地 `.env`）。

### 4. 长任务（视频）

- `oasis-tool video.generate …` 提交后拿到任务号，然后自己每隔 5 秒问一次进度（`GET /v1/tools/jobs/:id`），做好就下载到指定位置；等待期间不调用模型、不花 token。
- 一条命令最多等 100 秒（`OASIS_TOOL_WAIT_SECONDS`），免得碰上运行命令的时间限制；没等到就把任务号告诉 AI，AI 先做别的，再运行 `oasis-tool wait <任务号>` 接着等。dsh 的命令超时不用改。
- 冻结在提交时（冻结时长 = 等待上限 + 10 分钟），结算在完成时；供应商说失败或超时就退回。model-gateway 用表 `tool_jobs` 记供应商的任务号和进度，多个请求同时来取时只有把记录从 pending 改掉的那一个结算。
- 等待上限 `TOOL_JOB_TIMEOUT_MS`，默认 30 分钟（实现时从草案的 10 分钟放宽：视频模型排队时常超过 10 分钟）。
- 视频模型默认 `alibaba/wan-3.0`、`minimax/hailuo-2.3`、`kwaivgi/kling-v3.0-std`（都是每秒不超过 $0.20），冻结按每秒 $0.25 算；换更贵的模型要同时调冻结。

### 5. 规划员和节点

- 规划员看到可用工具的目录（名字、说明、单价），在方案里给干活节点写 `tools: [{"key": "image.generate", "uses": 2}]`（uses 是预计用几次，用来估算，不是硬上限）。规划门检查：工具存在且可用。讨论节点不用工具。
- 节点的说明里只列它被分到的工具名，并让它先运行 `oasis-tool list` 看用法（用法以目录为准，不在两处维护）。用户也可以在节点开跑前改它的工具。
- 预估：每个工具在目录里有「一次大约多少钱」，规划员给每个节点估计会用几次，代码汇总进预估（仍然由代码算，不让 AI 估钱）。

### 6. 算力计费（harness → model-gateway → billing）

- harness 按沙箱容器实际存在的时长 × CPU 核数 × 单价计费。单价 `COMPUTE_PRICE_MICRO_PER_CORE_HOUR`（model-gateway）默认按云服务器成本价，每核每小时 $0.015；开发时可设为 0（为 0 就不冻结也不结算）。
- 开容器前按最长运行时间冻结（`POST /internal/v1/compute`），容器销毁后按实际时长结算（`POST /internal/v1/compute/:callId/settle`）。
- 实现时改为经 model-gateway 计量（原草案写的是 harness 直接找 billing）：冻结、结算、调用记录（`kind = compute`）、计入任务的 `model-gateway.call.settled` 事件都复用同一套，不在 harness 里再写一份。
- task 的预估每次运行加上算力（`ESTIMATE_COMPUTE_RUN_MICRO`，默认 $0.0025 ≈ 2 核 × 5 分钟）。
- 5.7 的预览环境、5.9 的云 GPU 用同一套。

### 7. 出口代理和软件包镜像

- 新增出口代理 `oasis/sandbox-egress`（tinyproxy）：只放行 `SANDBOX_EGRESS_ALLOW_HOSTS` 里的域名（精确匹配），HTTPS 隧道只能连 443，其他一律拒绝。它和入口代理一样同时在内部网络和外网上。
- 仓库地址写在根目录 `.env`：`SANDBOX_NPM_REGISTRY`、`SANDBOX_PIP_INDEX_URL`、`SANDBOX_EGRESS_ALLOW_HOSTS`。开发机（国内）用 npmmirror 和清华 PyPI 镜像，部署到海外后换回官方源，只改这三项（已记入「上线前要改的配置」）。代码和 compose 的默认值是官方源。
- 沙箱镜像里装好 Python 3（含 pip、venv）和中文字体（Noto CJK）：节点里的 AI 常用 Python 处理文档和图片（python-docx、Pillow 排中文字）。镜像因此大了约 250MB。
- harness 给沙箱设好 `HTTPS_PROXY`、`npm_config_registry`、`PIP_INDEX_URL`、`UV_DEFAULT_INDEX`，入口代理在 `NO_PROXY` 里；AI 照常 `npm install`、`pip install` 就行。`SANDBOX_EGRESS_PROXY` 留空时沙箱完全不能出站。

### 8. 场景经验手册

- agent 里存一组经验手册（`services/agent/playbooks/*.md`，第一行「# 名称」，第二行「> 适用：……」），每类场景一份：这类任务一般怎么分工、用哪些工具、交付物长什么样、常见的坑。task 经 `GET /internal/playbooks` 读取。
- 规划员开工前用 Jev 判断任务单属于哪几类场景，把对应的手册附进说明。实现时从一个 Choice 问题改为每份手册一个「是否属于」（一次调用，几乎不花钱，计入任务）：一个任务常常同时有文字和图片（如「首页文案 + 首屏效果图」），只选一类会漏掉另一类。概率 ≥ 0.5 的附上，最多两份；查不到或出错就不附，规划照常进行。
- 5.4 先写好机制和第一批手册（文档类、图片类）；之后每批场景（5.6–5.10）补齐各自的手册。

## 子步骤

| 步骤 | 内容 |
|---|---|
| 5.4a | 工具目录、`oasis-tool`、能力网关、入口代理放行；`web.search` / `web.fetch` / `jev.decide` / `image.generate` / `audio.speech` / `audio.transcribe` |
| 5.4b | 长任务（`video.generate`）；规划员和节点用上工具；预估加上工具 |
| 5.4c | 算力计费；出口代理和软件包镜像；场景经验手册 |

每步用假供应商测完，最后用真实供应商验收：生一张图、搜一次网、配一句音（预计合计 $0.05–0.15，跑之前先问用户）。

## 需要用户提供

- Tavily 的 API Key：直接填进你电脑上仓库根目录的 `.env`（变量名 `TAVILY_API_KEY`），不要贴到聊天里。

## 后果

- 沙箱镜像多一个 `oasis-tool`，入口代理多放行一条路径；安全边界不变（沙箱仍然只能连入口代理和出口代理）。
- model-gateway 从「模型网关」变成「能力网关」，所有外部能力都在这里计量；以后接 fal.ai 等新供应商只在这里加适配。
- OpenRouter 的多模态接口和价格变化较快，供应商适配要有集成测试兜底。
