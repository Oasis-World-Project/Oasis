# ADR 0024：检查服务 inspector，服务调用只往一个方向走

状态：已采纳（执行方案阶段 3，用户 2026-11-08 确认方案）。检查规则本身（ADR 0017、0021）不变，只换了在哪里做、谁付钱。

## 1. 起因

- harness 一身两份工：既在沙箱里跑 AI，又替 canvas、conversation、model-gateway、task 做文件解析、音视频解码、网页的浏览器检查、外站测试、模型预览、素材解析。
- model-gateway 和 harness 互相调用：harness 签运行 Key、结算算力要调 model-gateway；model-gateway 的 `app.check` 要读运行中沙箱的文件、`website.test` 要用 harness 的检查浏览器，又回调 harness。
- 检查浏览器的记录表（`check_browsers`）、算力冻结续租、重启后的接管都写在 harness 里，执行和检查的问题混在一起排查。

## 2. 决定

1. **新服务 inspector**（端口 4109，第 10 个服务）：判断成果的检查都在这里——文件解析、音视频解码、网页的浏览器检查（交付关卡、节点自查 `app.check`、外站测试 `website.test`）、模型预览、用户素材解析。
2. **inspector 不调别的服务、不存东西、不连数据库和事件。**
   - 要检查的内容由调用方给：所属服务签发的对象存储临时下载链接（harness 的运行产出包 `POST /internal/runs/:id/outputs/link`，有效 1 小时，一次关卡的几类检查共用；canvas 签发的素材链接），或直接放在请求里（模型文件、节点自查的应用文件）。inspector 只认 `SOURCE_ORIGINS` 里放行的对象存储地址，不能被当成任意网址的代理。
   - 结论交回调用方，要留档的由调用方存：交付关卡的浏览器检查报告由 task 存回 harness（`PUT /internal/runs/:id/application-check`），用户照旧在工作流里下载。
3. **开容器的检查由付钱的一方定核数，算力在 model-gateway 冻结、按 inspector 报回的实际用量（核数 × 实际用时）结算，记在任务和节点上。** 检查没做完不收钱；结算没成功时冻结到期自动退回，不会多扣。
   - 交付关卡（task 付）：音视频解码 `media-check`（`MEDIA_CHECK_CPUS` 默认 2 核、`MEDIA_CHECK_TIMEOUT_MS` 默认 90 秒）；浏览器检查 `application-check`（`BROWSER_CHECK_CPUS` 默认 2 核，一次冻结 `BROWSER_CHECK_MAX_MS` 默认 1 小时）。
   - 节点自查 `app.check`、外站测试 `website.test`（调用的节点付）：model-gateway 在处理这次工具调用时就地冻结、结算（同样的 `BROWSER_CHECK_*` 配置）。
   - 浏览器检查不设时限（2026-11-04 用户决定）：超过冻结时长的部分不再计费。
4. **检查容器用完即删。**
   - 音视频解码：沙箱基础镜像，不联网、限核，受信脚本 `media/media-check.mjs` 完整解码一遍。
   - 浏览器检查：镜像 `oasis/inspector-browser`（Playwright + Chromium，`pnpm browser:build`），应用和浏览器同容器、无外部网络；控制端（`browser/controller.mjs`，检查动作在 `browser/checks.mjs`）经 stdin/stdout 一行一个 JSON。静态网页套上和画布一样的隔离框外壳（ADR 0021）。外站测试的请求由控制端转给 inspector 代取，只放行 `WEBSITE_TEST_ORIGINS` 里的 HTTPS 来源，只许 GET/HEAD。
   - 容器设 `AutoRemove`；浏览器容器 `StdinOnce`：inspector 断开（检查结束、调用方断开、inspector 意外退出）时控制端退出、容器被删，不留孤儿。建好还没启动就中断的容器每 10 分钟清一次。同时开的检查浏览器 `BROWSER_CONCURRENCY`（默认 3）个、解码容器 `MEDIA_CHECK_CONCURRENCY`（默认 2）个，多的排队。
5. **`app.check` 的文件随调用带来。** 沙箱里的 oasis-tool 读好 `out/<dir>` 的文件（最多 1000 个、25 MB）随调用上传，model-gateway 转给 inspector；旧版沙箱镜像不带文件，`app.check` 会说明要重建镜像（`pnpm sandbox:build`）。
6. **服务之间的同步调用只往一个方向走。**
   - 执行链路：task → harness、model-gateway、inspector；harness → model-gateway（运行 Key、计费）；model-gateway → inspector（`app.check`、`website.test`）；沙箱里的工具经入口代理到 model-gateway。model-gateway 不再调 harness（去掉 `HARNESS_URL`）。
   - `pnpm check:engineering` 的「服务调用无环」按 `createServiceClient('<对方>', …)` 画调用图：inspector 调了任何服务、或出现新的环都拦下。
   - 已知例外：画布读任务的成果和详情（canvas → task）、开数字人会话（canvas → model-gateway），和 task、harness、model-gateway 调画布的边成环。它们不在执行链路上、改动面大，这次先放行这两条边，画布重整时再拆。

## 3. inspector 的接口

| 接口 | 调用方 | 做什么 |
|---|---|---|
| `POST /internal/files/check` | task | 解析运行产出包里的文件（能不能用、数量、图片尺寸） |
| `POST /internal/media/check` | task | 音视频、平台工程（`.mlt`）、字幕完整解码 |
| `POST /internal/applications/check` | task | 交付关卡：产出包里这份 `oasis-app.json` 所在的网页在检查浏览器里跑一遍 |
| `POST /internal/applications/check-files` | model-gateway | 节点自查 `app.check`：随调用带来的 `out/<dir>` 文件跑同一套检查，不留档 |
| `POST /internal/websites/check` | model-gateway | 外站测试 `website.test` |
| `POST /internal/materials/inspect` | conversation | 接需求时读用户上传的素材 |
| `POST /internal/models/inspect`、`/internal/models/poster` | canvas | 画布的模型预览 |

开容器的三个检查接口都回报 `usage: { cores, elapsedMs }`，调用方据此结算；调用方断开时检查随之停下。

## 4. 迁移

- harness 删掉预览服务、检查浏览器的代码和 `check_browsers` 表（contract 迁移 `20261108170000`），配置去掉 `PREVIEW_*`、`WEBSITE_TEST_ORIGINS`；镜像 `oasis/harness-preview` 改名 `oasis/inspector-browser`，命令 `pnpm preview:*` 改为 `pnpm browser:build`、`pnpm browser:smoke`。
- 第一次用新代码：`pnpm env:init`（补上 inspector、model-gateway、task 的新配置），`pnpm sandbox:build`、`pnpm sandbox:build:3d`（oasis-tool 会带文件），`pnpm browser:build`，再重启 `pnpm dev`。

## 5. 现状

- 回归 11 个场景全过；`web` 场景覆盖节点自查 `app.check`（沙箱 → 模型网关 → inspector）、浏览器检查的算力结算在任务上、下载的检查报告是修好后通过的那次；`video` 场景覆盖解码检查的算力结算。
- `pnpm browser:smoke` 走交付关卡同一条路：静态网页、Node 应用各查一遍通过和不通过的计划，外站测一次 example.com。
- ADR 0023 §4 里待拆的 `preview/controller.mjs` 已搬进 inspector，拆成 `controller.mjs` 和 `checks.mjs`。
