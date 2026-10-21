# Oasis · Agent 规则

> 每次任务开始前必须完整读取本文件。`CLAUDE.md` 等其他 Agent 的规则文件只引用本文件，不另写规则。
> 本文件分两部分：第一部分是 Oasis 的项目约定，第二部分是通用工程规范。两者优先级相同，冲突时先报告，不要擅自选择。

# 第一部分　Oasis 项目约定

## A. 项目速览

- 产品：人 + 多家 AI 共处的社交娱乐空间。当前阶段是 MVP（任务闭环）；不做任何付费，新用户注册送 $30 额度，所有模型和工具调用都从额度里扣。
- 架构的单一事实源：`docs/engineering/项目工程方向.md`；已做的决定：`docs/adr/`。
- 目录：`apps/`（web、desktop）· `services/`（9 个微服务）· `packages/`（契约、基础设施库、设计令牌、tsconfig）· `infra/`（本地编排）· `scripts/`（检查与清理）· `docs/`。

| 命令 | 作用 |
|---|---|
| `pnpm env:init` | 生成根目录和每个服务的本地 `.env`（随机密码） |
| `pnpm infra:up` / `infra:down` / `infra:ps` | 启动中间件 / 停止全部容器 / 查看 |
| `pnpm dev` | 9 个服务 + Web（Vite，http://127.0.0.1:5173）在本机运行，改代码自动重启 / 热更新 |
| `pnpm desktop` | 打开 Electron 桌面窗口（加载上面的 Web 地址，需先 `pnpm dev`） |
| `pnpm stack:up` / `stack:logs` | 中间件 + 9 个服务全部在容器里跑（集成验证）/ 看日志 |
| `pnpm lint` · `pnpm typecheck` · `pnpm test` | 静态检查、类型检查、测试 |
| `pnpm check:engineering` | 命名、镜像命名、设计令牌、依赖方向、死代码、重复率、迁移检查 |
| `pnpm cleanup` | 任务收尾清理并报告释放空间（`--build`、`--docker` 可选） |

## B. 架构约定

1. **微服务边界**：每个服务独占数据库（同一个 PostgreSQL 实例里的独立 database + 独立账号，其他账号连不上）。服务之间只走 HTTP API 或 NATS 事件；跨服务 import 由 dependency-cruiser 拦截。
2. **共享包**：`packages/*` 只放契约（contracts）、基础设施库（service-kit）、设计令牌和 tsconfig，不放业务逻辑。
3. **Harness 隔离**：全仓只有 `services/harness/src/adapter/` 能接触 DeepSeek Harness；dsh 版本精确锁定。
4. **模型调用**：所有模型调用（聊天、Jev、dsh 里的 agent）都经过 `services/model-gateway`，由它计量并上报 billing。
5. **服务内分层**：`src/api → src/service → src/repo`，禁止反向。
6. **配置外置**：配置全部来自环境变量，每个服务提供 `.env.example`；禁止硬编码地址、端口、密钥；禁止 `if (env === 'local')` 一类分支。
7. **运行时**：结构化 JSON 日志输出到 stdout；每个服务暴露 `/health` 和 `/ready`；收到 SIGTERM 后处理完在途请求再退出。
8. **数据库迁移**：dbmate 纯 SQL。文件头写 `-- phase: expand|migrate|contract`，必须有 `-- migrate:down`；expand 迁移必须写 `-- contract-plan:`。`pnpm check:engineering` 会检查这几项。
9. **依赖版本**：一律精确版本（pnpm `saveExact`）；多个工作区共用的依赖写进 `pnpm-workspace.yaml` 的 `catalog`，package.json 里用 `"catalog:"` 引用。
10. **镜像命名（没有例外）**：本项目构建和运行的每一个镜像都命名为 `oasis/<组件>:<标签>`，组件名小写（Docker 不允许大写），包括自研服务、中间件、以后 harness 的任务沙箱。
    - 第三方镜像不直接使用：在 `infra/images/<组件>/Dockerfile` 里 `FROM` 官方镜像（锁定版本）做一层薄包装，标签沿用上游版本号，例如 `oasis/postgres:18.6`。
    - compose 里每个服务必须同时写 `image: oasis/...`、`build:` 和 `pull_policy: build`：只在本地构建，绝不从镜像仓库拉取，因为 Docker Hub 上的 `oasis` 命名空间不归我们。
    - 脚本里的 `docker build` 必须带 `-t oasis/<组件>:<标签>`。
    - `pnpm check:engineering` 的 images 检查和 pre-commit 钩子会强制执行这一条。
11. **服务骨架**：每个服务都用 `@oasis/service-kit` 的 `startService` 启动，不自己写监听、探针、信号处理。统一接口：`/health`、`/ready`、`/v1/meta`；业务接口放 `/v1/*`，服务间接口放 `/internal/*`（gateway 不转发）。端口：gateway 8080，其余 4101–4108（见 README）。Node 服务的镜像统一用 `infra/images/node-service/Dockerfile` 按 `SERVICE` 参数构建。相对导入写 `.ts` 后缀，只用可擦除的 TS 语法（不用 enum、namespace、参数属性）。
12. **前端约定**：
    - 颜色、阴影、圆角、字体一律来自 `@oasis/design-tokens`（CSS 变量 + Tailwind 主题），`apps/web/src` 里不写裸色值（`#xxx`、`rgb()` 等）；缺少的令牌先加进 `packages/design-tokens`。`pnpm check:engineering` 的 tokens 检查和 pre-commit 钩子会拦截。
    - 应用主体是「珍珠雾面」，广场和游戏是「午夜蓝 + 金线」（`data-theme="plaza"`），群主题光用 `data-light="coral|mint|sky|honey"`。
    - 侧栏 7 个入口就是全部一级页面；群聊、私聊不显示未读数字或红点（PRD G-02）。
    - 前端只通过 gateway 的 `/api/*` 访问后端；开发时由 Vite 转发。
    - 新依赖在第一次真正用到时才装（TanStack Query、Zustand、Radix 等），不预装。
    - 字体随应用打包（@fontsource），不引用外部字体服务。
    - Electron：保持 contextIsolation、sandbox、禁用 nodeIntegration；需要给页面开放能力时，只能通过 preload 暴露明确的接口。
13. **登录、额度与事件**（详见 `docs/adr/0002-auth-billing-chat-loop.md`）：
    - 鉴权只在 gateway 做。业务服务一律用 service-kit 的 `requireUserId` / `requirePayerId` 读 `x-oasis-user-id` / `x-oasis-payer-id`，不自己解析 Cookie。
    - 金额一律用微美元整数（`*Micro` 字段），不用浮点存钱。
    - 任何模型或工具调用都必须经过 model-gateway 的「冻结 → 结算 / 退回」，并在 `x-oasis-payer-id` 里写明谁付钱。
    - 跨服务的事件一律走 outbox（`startOutboxRelay`）+ 持久消费者（`startEventConsumer`）。消费者必须幂等，事件类型写在 `packages/contracts/src/events.ts`。
    - 密钥（`*_PASSWORD`、`*_SECRET_KEY`、`*_ACCESS_KEY`、`*_PEPPER`、`OPENROUTER_API_KEY`）只放在本地 `.env`，不进 git，不写进日志，也不要贴到聊天里。

## C. 本项目对通用规范的调整（用户 2026-10-21 确认）

- 取消“修改超过 3 个非测试文件先停下说明”一条（第二部分 §2）。
- 第二部分 §1 第 5 条的两个脚本用 Node 实现（`.mjs`），因为主力开发机是 Windows，没有统一的 bash。
- 清理钩子：Claude Code 已在 `.claude/settings.json` 注册 Stop 钩子；其他 Agent 在任务收尾手动运行 `pnpm cleanup`。
- 宿主机 Docker 的定时清理（cron 或 Windows 计划任务）尚未配置，需要用户另行同意。

---

# 第二部分　通用工程规范

## 0. 文件用途与执行方式

本文件用于约束编码 Agent 在项目开发、修改、测试、迁移和收尾过程中的工程行为。

Agent 必须在每次执行任务前读取本文件，并遵守以下优先级：

1. 用户当前明确指令
2. 本文件规则
3. 项目已有局部约定
4. Agent 自身默认习惯

发生冲突时，先报告冲突，不要擅自选择。

核心目标：
- 修改优先，避免只增不减
- 高内聚、低耦合，避免小改动扩散到大量文件
- 数据库演进必须可回滚、可收缩，不能只加表不加清理
- 中间产物必须清理，非最终交付物默认视为临时产物
- 软规则必须配合确定性工具、CI、钩子或定时任务兜底

---

## 1. Agent 收到本文件后的自配置动作

Agent 应先完成以下配置，再开始业务开发：

1. 将本文件放入项目根目录，并接入当前 Agent 的规则读取机制，例如：
   - `AGENTS.md`
   - `CLAUDE.md`
   - `.cursor/rules`
   - `GEMINI.md`
   - 其他项目级 Agent 规则文件
2. 如果项目已有规则文件，合并本文件内容，不要覆盖用户已有规则。
3. 在项目任务模板或 README 中注明：每次任务开始前必须读取本文件。
4. 如 Agent 支持 hooks / lifecycle events，注册任务结束清理钩子：
   - 会话结束
   - 任务完成
   - Stop / SessionEnd / AfterTask
   - 钩子调用项目内清理脚本，而不是直接执行危险系统命令
5. 创建或建议创建以下脚本：
   - `scripts/cleanup-task.mjs`：清理本次任务产生的临时产物
   - `scripts/check-engineering.mjs`：运行死代码、重复率、依赖方向、未使用依赖检查
6. 如涉及宿主机 Docker 清理，必须先获得用户允许，再配置 cron 或系统定时任务。
7. 首次接入时运行一次基线扫描，报告当前技术债和可清理空间。

安全边界：
- 可以默认删除：本次任务创建且可再生成的临时文件、缓存、临时容器、临时镜像。
- 不得擅自删除：Git 跟踪文件、用户数据、未知文件、生产数据库结构、共享资源、非本次任务创建的 Docker 资源。
- 不确定时：报告并询问，不要猜。

---

## 2. 每次任务标准流程

Agent 每次执行必须遵循以下流程：

1. 读取本文件和项目规则。
2. 搜索现有实现：新增函数、类、文件、表之前，先全局搜索是否已有相似逻辑。
3. 输出简要计划：
   - 目标
   - 预计修改的模块
   - 是否涉及数据库迁移
   - 是否涉及新增文件或新增表
   - 清理计划
4. 明确“受影响模块清单”。
5. 实施修改，优先原地重构，不创建平行副本。
6. 运行测试、静态检查和必要验证。
7. 清理本次任务产生的中间产物。
8. 输出任务报告，包含变更范围、验证结果、清理结果和未完成风险。

（原“修改超过 3 个非测试文件必须先停下说明”一条已按用户 2026-10-21 的决定取消；仍须遵守 §3 的最小影响原则。）

---

## 3. 架构与解耦规则

1. 依赖方向必须清晰：
   - UI / 接口层 → 服务层 → 数据访问层
   - 禁止反向依赖，例如数据层不得依赖 UI 组件。
2. 单一职责：
   - 新增逻辑前先检查现有模块是否已有相关职责。
   - 如果已有，优先扩展现有模块，而不是新建平行实现。
3. 禁止隐式耦合：
   - 不得通过全局变量、隐式副作用、共享可变状态连接两个本应独立的模块。
   - 跨模块通信必须通过显式接口。
4. 接口冻结：
   - 设计完成后冻结 public API。
   - 不得为了“方便实现”擅自扩大 public API。
5. 变更范围锁定：
   - 除非任务明确要求，不得修改与当前需求无关的文件。
   - 不得为了“顺手优化”扩大变更范围。
6. 没有设计，不要编码：
   - 涉及跨模块、数据库、公共接口的变更，必须先给出设计说明。
   - 简单局部修改可以直接实施，但仍需遵守最小影响原则。

---

## 4. 代码层“只增不减”防治规则

1. 禁止版本后缀命名：
   - 禁止 `_v2`、`_new`、`_old`、`_backup`、`_copy`、`_refactored` 等后缀。
   - 版本演化属于 Git 历史，不属于文件名。
   - 发现已有此类文件，应视为技术债合并清理，不得继续沿用。
2. 强制原地重构：
   - 修改现有文件，不创建平行副本。
   - Git 是安全网。先提交基线，修改原文件，跑测试；坏了用 `git revert`。
   - 不允许“为了以防万一保留旧版本并存”。
3. 新增前先搜索：
   - 新增任何函数、类、文件前必须搜索代码库。
   - 存在相似逻辑时，优先扩展或重构现有实现。
   - 只有确认完全不存在时，才允许新建。
4. 死代码清理：
   - 本次改动产生的孤儿代码，如未使用 import、变量、函数，必须删除。
   - 既有无关死代码只报告，不擅自扩大范围删除。
   - 注释掉的代码是 lint 错误，不是安全网，应删除；Git 会记住历史。
5. 禁止用新增掩盖问题：
   - 不得通过新增包装层、平行模块、临时兼容文件来绕过既有设计问题。
   - 如果问题来自结构缺陷，先提出重构方案。

---

## 5. 数据库演进规则

数据库变更必须遵循 Expand → Migrate → Contract 三阶段：

1. Expand：添加新列或新表，保留旧结构，应用双写。
2. Migrate：回填数据，验证一致性，应用切换为读新结构。
3. Contract：确认旧结构不再被读写后，删除旧列或旧表，并清理双写与兼容代码。

强制要求：
- 禁止把三个阶段压缩进一次不可回滚的迁移。
- 每次迁移必须独立、可回滚。
- Contract 是迁移的必选终态，不是可选优化。
- 如果 Contract 必须跨部署完成，必须在任务报告中列为未完成阻塞项，不得宣称任务完成。
- 不得用“新增关联表”掩盖本应修复的数据模型问题。
- 新增表前必须说明：为什么不能修改现有表，为什么不能走 Expand-Contract。

数据库安全边界：
- 不得擅自删除生产数据库结构。
- 删除旧结构前必须有数据一致性验证和回滚方案。
- 迁移脚本必须可审查、可回滚、可重复执行。

---

## 6. 中间产物与磁盘清理规则

从用户视角：不是最终交付物的内容，默认意义不大。

Agent 任务收尾必须清理本次运行产生的临时产物，包括但不限于：
- `__pycache__`
- `.pytest_cache`
- `*.tmp`
- 临时日志
- 构建中间目录
- 本次任务创建但不再需要的 Docker 容器、镜像、构建缓存
- 测试生成的临时数据库、临时文件、临时目录

清理原则：
1. 清理是任务完成的必选步骤，不是可选优化。
2. 删除是默认允许的操作，但仅限本次任务创建且可再生成的临时产物。
3. 对构建目录、依赖目录、未知文件，只报告并询问，不擅自删除。
4. 清理后必须报告释放的空间量。
5. 清理不得影响最终交付物和用户数据。

Docker 清理建议：
- 默认清理本次任务创建的临时容器和临时镜像。
- 悬空镜像可使用 `docker image prune -f`。
- 构建缓存可使用 `docker builder prune -f --filter until=72h`。
- 不建议默认执行 `docker image prune -a` 或 `docker system prune`，除非用户明确允许。
- 宿主机级清理应通过 cron 或系统定时任务兜底，并先获得用户允许。

建议 cron 示例，需用户确认后配置：
- 每日清理悬空镜像：`docker image prune -f`
- 每周清理超过 72 小时的构建缓存：`docker builder prune -f --filter until=72h`

---

## 7. 验证与确定性工具

本文件是软约束，必须配合确定性工具兜底。

建议接入：
- 死代码与未使用导出：`knip`、`ts-prune`
- 未使用依赖：`depcheck`
- 重复代码：`jscpd`
- 依赖方向与循环依赖：`dependency-cruiser`
- 架构违规 lint：`eslint-plugin-stackrules` 等
- 数据库迁移：`pgroll` 等支持 Expand-Contract 的工具
- AI 产物清理：`slopforge`、`save-space-skills`、`repurge`、`OpenClearn`、`z-clean` 等

CI 硬门禁建议：
- 重复率超过阈值即失败
- 死代码检测失败即阻断合并
- 禁止版本后缀命名
- 禁止反向依赖和循环依赖
- 数据库迁移缺少 Contract 计划即阻断

规则如果不在 CI 或钩子中真正运行，就只是书面建议。

---

## 8. 完成定义 Checklist

任务只有同时满足以下条件，才能标记完成：

- [ ] 已读取并遵守本文件
- [ ] 已搜索现有实现，未重复造轮子
- [ ] 已列出受影响模块清单
- [ ] 修改以原地重构为主，未创建平行副本
- [ ] 未使用版本后缀命名
- [ ] 未扩大无关变更范围
- [ ] 本次改动产生的孤儿代码已删除
- [ ] 数据库变更遵循 Expand-Migrate-Contract
- [ ] Contract 计划已执行或明确列为阻塞项
- [ ] 测试和静态检查已通过
- [ ] 本次任务临时产物已清理
- [ ] Docker 临时资源已清理或已报告
- [ ] 已报告释放空间
- [ ] 已输出任务报告

---

## 9. 任务报告模板

Agent 每次任务结束必须输出：

1. 任务目标
2. 受影响模块清单
3. 修改文件数量及原因
4. 是否新增文件、新增表、新增依赖；如新增，说明为什么不能复用或重构
5. 数据库迁移阶段：Expand / Migrate / Contract 状态
6. 验证结果：测试、lint、依赖检查、重复率检查
7. 清理结果：删除了哪些临时产物、释放空间、Docker 资源清理情况
8. 未完成项与风险
9. 下一步建议

如果任何一项无法完成，必须明确说明，不得隐瞒。
