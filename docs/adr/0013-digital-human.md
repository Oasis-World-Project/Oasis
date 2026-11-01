# ADR 0013：5.10 实时数字人

- 状态：设计已定（2026-11-01；用户决定见 §10，分三步实现见 §11）
- 依据：业务场景 12（`claude/business-scenarios.md`）、工程决策「数字人保留在第 5 阶段；画布里实在不能预览也可以，有产出就行；是否长期托管上线以后再定」、ADR 0006（工具与能力网关）、ADR 0009（可运行成果）、ADR 0012（修改成果）、供应商调研文档（2026-11-01，选定 LiveAvatar）
- 范围：contracts、model-gateway、canvas、agent（经验手册）、web。不新增服务，不新增数据库表以外的基础设施。

## 1. 用户看到的

| 环节 | 内容 |
|---|---|
| 提需求 | 在私聊里说「做一个民宿前台数字人，能用中文回答入住、早餐、交通问题，答不上来就转人工」。和其他任务一样问需求、确认任务单 |
| 交付 | 一个「数字人」成果：人设、开场白、知识要点、转人工规则、形象、声音、语言。画布里归在「网页和应用」 |
| 预览 | 成果页点「开始对话」，允许麦克风后直接和数字人说话：它听、答、口型同步。页面旁边实时显示对话记录、它查了哪些资料、有没有触发转人工、每轮等了多久、这次已经用了几分钟和多少钱 |
| 结束 | 点「结束」，或到最长时长、长时间不说话、关掉页面，会话结束，按实际分钟结算 |
| 修改 | 走 5.11 的修改路径：「发给 AI 修改」或参数面板（声音、语气、形象、语言等）做出新一版，整体替换 |
| 部署配置 | 成果里附一份部署说明和配置文件，用户以后可以拿去自己上线；Oasis 暂不长期托管（上线以后再定） |

## 2. 供应商与模式

- **LiveAvatar（HeyGen 的实时数字人产品，2025-11 独立出来，单独的账号、积分和 API Key；不需要 HeyGen 账号，HeyGen 的 Key 也不通用）**，FULL 模式：听写、配音、口型和形象由它负责。
- **大脑接我们自己的模型**：LiveAvatar 的「自定义大模型」每轮对话调用一个 OpenAI 兼容的 `/chat/completions`。我们在 model-gateway 加一个只给数字人用的入口（§4），模型、计费、知识要点、转人工都在我们这边。
- 不用 LITE 模式（要我们自己搭实时语音链路）；不用它自带的 OpenAI 模型（钱和模型选择不在我们手里）。

## 3. 成果：数字人配置文件

节点交付 `out/<名字>.oasis-avatar.json`，契约 `AvatarSpec`（contracts 新增）：

| 字段 | 说明 |
|---|---|
| `name`、`language` | 名字；语言代码（取自 LiveAvatar 支持的语言列表） |
| `avatarId` | 形象：公共形象，或用户在 LiveAvatar 后台自己做的形象（列表里能看到的才可选） |
| `voiceId` | 声音：从声音列表里选 |
| `prompt` | 人设与规则（系统提示词，含边界和语气），上限 8,000 字 |
| `openingText` | 开场白；第一句说明自己是 AI（欧盟 AI 法案第 50 条告知义务） |
| `knowledge` | 知识要点：若干条「标题 + 内容 + 来源」，合计上限 30,000 字；对话时由我们这边检索后放进当轮提示，回答带来源 |
| `handoff` | 转人工规则：什么情况转、转时说的话 |
| `maxMinutes` | 预览单次最长分钟数，默认 5，最多 15 |

canvas 认出 `.oasis-avatar.json` 就登记为数字人成果（同 ADR 0009 认出可运行应用的做法），类别「网页和应用」，带上形象预览图（来自 LiveAvatar 的 `preview_url`）。

**工作流里怎么做**：model-gateway 新增只读工具 `avatar.catalog`（列公共形象、用户自建形象、声音、语言），节点用它挑形象和声音；新增经验手册 `digital-human.md`（怎么写人设、知识要点、转人工、开场白，配置文件怎么写、怎么自查）。规划员照常决定分工，不写死模板。可选再用 OpenRouter 上的 Avatar IV 生成一段宣传片（已有的生视频工具，不新增）。

**风格化形象**：LiveAvatar 的图片形象只能在它的后台创建（需要付费的形象位），API 只能列出和使用。所以：二次元、卡通等形象由用户在 LiveAvatar 后台做好，Oasis 的 `avatar.catalog` 就能列出来给 AI 选。官方说明模型按「类人五官」优化，效果要先试。

## 4. 实时会话怎么跑

```
成果页「开始对话」
  → canvas POST /v1/artifacts/:id/avatar-sessions（校验是自己的成果）
  → model-gateway /internal/avatar/sessions
      1. 冻结额度：maxMinutes × 每分钟单价（§5）
      2. 签一把会话专用的临时 Key（沿用 run-keys，绑定付款人、任务、成果、会话）
      3. 在 LiveAvatar 建：secret（这把临时 Key）→ llm_configuration（指向我们的公网入口和模型）
         → context（prompt、openingText）→ session token（FULL、avatar、voice、language、max_session_duration）
         → start session，拿到 LiveKit 地址和客户端令牌
  ← 浏览器用 LiveKit 连上；对话期间每轮：
     LiveAvatar → 公网入口 /avatar/v1/chat/completions（Bearer 临时 Key）
       → model-gateway：按 Key 找到会话和配置 → 检索知识要点放进提示 → 调模型（OpenRouter，按量计费）
       → 模型要转人工时（函数调用 handoff_to_human）→ 流式回给 LiveAvatar 转人工的话，并记一条事件
  结束（用户点结束 / max_session_duration / 闲置 / 断开 / 额度用完）
  → model-gateway：stop session → 删掉 LiveAvatar 上的 context、llm_configuration、secret → 作废临时 Key
     → 按实际分钟结算，退回多冻结的部分
```

- **结束的兜底**：浏览器关掉时发不出「结束」，所以 model-gateway 有清扫任务：会话过了最长时长加 2 分钟仍没结算的，向 LiveAvatar 查会话状态、停止并按查到的时长结算（同 5.9 渲染的断连结案）。
- **前端**：`@heygen/liveavatar-web-sdk`（或直接 `livekit-client`，实现时看哪个更薄，精确锁版本）；视频、麦克风权限、开始和结束、对话记录（LiveAvatar 的 `user.transcription`、`avatar.transcription` 事件）、检索和转人工记录（我们这边按会话查）、每轮延迟（`user.speak_ended` 到 `avatar.speak_started`）、已用分钟和花费。
- **聊天里**：交付消息里数字人成果显示形象图和「去画布对话」，不在私聊里直接开会话。

## 5. 计费

| 部分 | 怎么算 |
|---|---|
| 数字人分钟 | LiveAvatar FULL 每分钟 2 积分；按会话分钟向上取整 × 2 × 积分单价。单价是配置 `AVATAR_CREDIT_MICRO`，默认 95,000（Essential 超额价 $0.095/积分）。乘系统现有的定价系数 |
| 大模型 | 公网入口的每次调用和现在一样经计量，记到同一个付款人、任务和会话 |
| 冻结 | 开始时按 `maxMinutes` 冻结分钟费用；结束按实际结算 |

5 分钟一次的预览约 $0.95 加少量大模型费用。工作流本身（写配置、选形象）和普通文档任务一样便宜。

## 6. 公网入口

LiveAvatar 从它的服务器调用我们的 `/chat/completions`，地址必须公网可达。

- model-gateway 新增一个**单独端口**（`AVATAR_LLM_PORT`，默认 4118），上面只有 `POST /avatar/v1/chat/completions`，只认会话临时 Key；其他内部接口不在这个端口上。公网只暴露这一个端口的这一个路径。
- **开发期**（现在）：服务器上跑着另外四个项目，不部署 Oasis。本机开 SSH 反向隧道：服务器 `127.0.0.1:<端口>` → 本机 `4118`；服务器上共用的 nginx 加一个子域名，只把 `/avatar/v1/chat/completions` 转到隧道口，其余返回 404。配置 `AVATAR_PUBLIC_BASE_URL=https://<子域名>`。隧道断了，会话会因为大模型调不通而失败，页面提示「数字人服务暂时连不上」。
- **上线后**：Oasis 部署好以后，同样只把这一个路径经反向代理暴露出去，隧道撤掉。

## 7. 开发和验收怎么省钱

- **沙箱模式**（`is_sandbox`）：不扣积分，只能用官方的 Wayne 形象，每次约 1 分钟自动结束。开发全程用它；能不能和自定义大模型一起用，第一步就实测。
- **免费档**：每月 10 积分（约 5 分钟 FULL），用来试真实形象和中文效果。
- **验收**：用免费档的 10 积分做几次短会话（见 §10）；不买 Essential。

## 8. 改动范围（预估）

- contracts：`AvatarSpec`、数字人会话请求与响应、会话事件。
- model-gateway：LiveAvatar 适配器、`avatar.catalog` 工具、数字人会话（开始、结束、清扫、结算）、公网入口（单独端口、检索知识要点、转人工函数）、迁移（数字人会话表）。
- canvas：认出数字人成果；`/v1/artifacts/:id/avatar-sessions` 转给 model-gateway。
- agent：经验手册 `digital-human.md`。
- web：数字人成果页（对话、记录、延迟、花费）；聊天交付卡显示形象图；参数面板加数字人一类（声音、语气、形象、语言、最长时长）。
- 新依赖：浏览器端 LiveAvatar SDK 或 livekit-client（精确版本）。

## 9. 不做

- LITE 模式、自己搭实时语音链路；Gemini 或 OpenAI 实时连接器。
- 在 Oasis 里创建定制形象（LiveAvatar 只能在它的后台建）。
- 长期托管上线、对外分享可对话的链接、并发上限管理（上线以后再定）。
- 会话录像（LiveAvatar 不存视频）；对话记录只在页面上显示，不入库（以后要再加）。

## 10. 用户的决定（2026-11-01）

- 子域名 `oasis-dev.elysiumgrid.space`（DNS 在 DNSPod，A 记录指向 43.173.126.57，由用户添加）；同意在服务器共用的 nginx 里加这一个站点和证书。
- 不买 Essential。验收用免费档：每月 10 积分，FULL 每分钟 2 积分、不足 1 分钟按 1 分钟算，所以够 4 到 5 次十几秒到一分钟的短会话；开发全程用沙箱。免费档还限 1 个并发、单次最长约 2 分钟、画面带水印，验收可以接受。二次元形象要付费形象位，这次不验。
- LiveAvatar Key 已由用户填进 `services/model-gateway/.env`；只读核验通过：余额 10 积分，公共形象和声音可列出，语言列表含中文。

## 11. 分三步做

| 步骤 | 内容 | 花费 |
|---|---|---|
| 5.10a 打通链路 | LiveAvatar 适配器；model-gateway 单独端口的公网入口；服务器上的 nginx 站点、证书和 SSH 反向隧道；用沙箱跑通「说话 → LiveAvatar → 我们的大模型 → 数字人回答」 | $0（沙箱）＋少量大模型 |
| 5.10b 会话与预览 | 会话开始、结束、清扫和结算；画布成果页的对话、记录、延迟、花费；知识要点检索和转人工 | $0（沙箱） |
| 5.10c 产出与验收 | `AvatarSpec`、`avatar.catalog`、经验手册、canvas 登记、交付卡和参数面板；一次真实任务做出数字人，再用免费积分做 2 到 3 次十几秒的真实对话 | 免费积分＋约 $0.1 大模型 |

## 12. 5.10a 实施记录（2026-11-01）

**做了什么**

- `adapters/liveavatar.ts`：LiveAvatar 最小客户端（秘钥、大模型配置、人设、会话令牌、开始、结束、查会话、余额）。出错信息只带状态、接口前两段路径和 LiveAvatar 的说明，不带路径里的编号和请求内容。
- `service/avatar-service.ts`：开会话依次签临时 Key → 存秘钥 → 建大模型配置 → 建人设 → 取会话令牌 → 开始；任何一步失败就倒序拆掉已建的部分。结束时停会话、拆配置、作废 Key；只能结束自己的会话，重复结束不报错；服务关闭时结束全部会话。5.10a 只在内存里登记会话，落库、按分钟结算和清扫在 5.10b。
- `api/avatar-server.ts`：4118 端口的数字人入口，复用 service-kit 的 `createHttpServer`（统一错误格式和探针），只有 `POST /avatar/v1/chat/completions`；只认**正在进行的数字人会话**的 Key（会话编号就是 Key 的 `runId`），沙箱里 agent 的 Key 从这里用不了。
- 内部接口 `POST /internal/avatar/sessions`、`POST /internal/avatar/sessions/:id/stop`（付费人在 `x-oasis-payer-id`）。
- 服务器（`ubuntu` 用户；用户确认后由用户本人执行脚本）：共用 nginx 新增 `/opt/shared-ingress/conf.d/oasis-dev.conf`，443 只把 `/avatar/v1/chat/completions`（仅 POST）和 `/avatar/health` 转到 `127.0.0.1:15200`，其余 404；Let's Encrypt 证书照其他站点用 certbot 容器 + webroot 签发；`oasis-dev-certificate-renew.timer` 一天两次续期；改前备份在 `/opt/shared-ingress/backups/20261101T110136Z-oasis-dev`。其他四个站点前后都是 200。
- `pnpm avatar:tunnel`：开 SSH 反向隧道（服务器 15200 → 本机 4118），断线 5 秒后重连。

**和文档不一样的地方**

- 秘钥类型：文档写 `LLM_API_KEY`，接口实际只收 `OPENAI_API_KEY`、`ELEVENLABS_API_KEY`、`GEMINI_API_KEY`、`FISH_API_KEY`、`CARTESIA_API_KEY`。我们的入口说 OpenAI 协议，用 `OPENAI_API_KEY`。
- 大模型配置的路径是 `/v1/llm-configurations`（连字符）；`base_url` 写到 `/avatar/v1` 为止，LiveAvatar 自己补 `/chat/completions`（实测）。
- 还有 `POST /v1-alpha/avatars/image`：从一张 16:9 或 9:16、短边至少 1080 的人像图建形象（内测接口，要形象位）。以后做风格化形象可以走它。

**沙箱实测（免费）**

- 公网入口：`/avatar/health` 经隧道返回 ok；不带 Key 401；GET 403；其他路径 404。
- 全链路：开沙箱会话 3–4 秒 → 加入 LiveKit 房间，数字人说开场白 → 发 `avatar.speak_response`「请用一句话介绍你自己」→ LiveAvatar 回调我们的入口 → DeepSeek V4.1 Flash 按我们的人设回答「我是 Oasis 的测试数字人，负责测试对话。」，逐字推送 `avatar.transcription.chunk`。调用记在测试账号上（`run_id` 就是会话编号），$0.0003。结束后两把临时 Key 都已作废，LiveAvatar 上没有遗留的秘钥、配置、人设和会话，积分仍是 10。
- 事件比文档多：`avatar.transcription.chunk`（逐字）、`lk.transcription` 文字流；`user.transcription` 的 `source_event_id` 指回我们发的命令。命令事件的字段直接平铺（`event_type`、`text`）。

**留给 5.10b**

- 首字延迟约 4.6 秒：模型为一句话输出了 605 个 token，在悄悄「思考」。数字人入口要关掉思考或换出字更快的模型；路径上还多了「LiveAvatar → 服务器 → 隧道回国内开发机」两跳，部署后会短一些。
- 结束会话约 18 秒（停会话加三次删除，都从国内网络发出）：删除可以并行，并且不用让用户等。
