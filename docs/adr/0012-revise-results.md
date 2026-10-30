# ADR 0012：5.11 修改成果

- 状态：设计已定（2026-10-31，Claude 定，待用户确认）；5.11a 按此实现
- 依据：ADR 0003 §1（修改成果、旧版本不保留）、ADR 0005（进门和出门）、ADR 0007（前端主干、画布与桌面同步）、`claude/canvas-module.md`（2026-10-22 修订版）、AGENTS.md
- 范围：contracts、task、canvas、conversation、harness、web、desktop。不新增服务。

## 1. 用户看到的规则

| 规则 | 内容 |
|---|---|
| 修改就是新的一版 | 用户在成果页写修改意见（以后加批注）并「发给 AI 修改」，系统新建一条工作流做出新版。用户看来就是重新生成；内部由规划员决定复用多少（见 §3） |
| 不再问需求 | 修改不走问题卡和任务单确认：修改意见由代码并入上一版的任务单，直接开跑。私聊里出现用户的修改意见和新的任务卡。用户在任务单里设过花费上限的，预估超过上限仍会先问（ADR 0005 原有规则） |
| 发给谁 | 默认是做出上一版的私聊 AI（原会话）；可以换成另一个 AI，修改出现在和那个 AI 的私聊里。和原来一样，这个 AI 只负责接需求，节点用什么模型由工作流决定 |
| 整体替换 | 新版顺利交付后，画布里上一版的全部成果被新版替换；上一版的工作流和中间产物一起清理。旧版本不保留、无法找回。新版沿用上一版在同步文件夹里的目录名 |
| 新版没做成 | 失败或取消时上一版原样保留，什么也不替换 |
| 同时只改一版 | 一份成果正在修改时，不能再发起第二次修改，也不能删除它；先取消正在进行的修改 |
| 新版要交齐 | 新版会整体替换上一版，所以必须交齐任务单里的全部交付物；没要求改的文件原样带过去 |
| 删除成果 | 以任务为单位：删除这个任务在画布里的全部成果，连同它的工作流和中间产物。要二次确认。进行中的任务先取消才能删。花费记录（账本）保留 |
| 电脑上的文件 | 已同步到电脑的旧版文件，如果用户没改过，新版直接覆盖；用户改过的不覆盖，新版另存为「名字 (新版).扩展名」。删除成果不会删除电脑上的文件 |
| 批准 | 只是成果上的一个「已批准」记号，方便用户自己区分；新版不带批准（5.11b） |
| 按段重做 | 不单设接口：批注或修改意见只指向某一章、某一张、某一轨即可，新版只改那里，其余原样带过去 |
| 参数面板 | 只影响观看的（播放器音量、3D 视角、灯光、线框）在页面上直接调，不改成果；要改成品的参数（字幕字号与位置、配乐音量、色温、3D 材质）在面板里填好后，生成一条结构化的修改意见，走同一条修改路径（5.11c） |

旧版的私聊卡片（任务卡、交付消息）保留文字记录，但标成「已被新版本替换」或「已删除」，不再提供下载和工作流入口。

## 2. 数据流

```
成果页「发给 AI 修改」
  → conversation POST /v1/conversations/:id/revisions {taskId, request, annotations, attachments}
      → canvas  POST /internal/revisions/materials：上一版的交付文件登记成素材（不复制对象）
      → task    GET  /internal/tasks/:taskId：上一版的任务单、说明和原素材
      → task    POST /internal/tasks {revisionOf, sheet+修改意见, brief+修改说明, materials}
      → 私聊里插入：用户的修改意见、任务卡
  → 规划员 → 节点 → 验收 → 交付（全部沿用现有流程）
  → task.task.status_changed(succeeded, revisionOf=上一版)
      → canvas：复制新版文件 → 删除上一版对象 → 一个事务里删旧行、插新行（同一个目录名）
                → task POST /internal/tasks/:old/retire {replacedBy}
      → task：删除上一版任务，发件箱写 task.task.deleted {replacedBy}
          → canvas：删除这个任务剩下的成果和修改素材（幂等）
          → harness：停掉它的预览、删除运行存档与运行记录
          → conversation：把它的任务卡、交付消息标成「已被新版本替换」
用户删除成果：web → task DELETE /v1/tasks/:id → 同样的 task.task.deleted（replacedBy 为空）
```

替换的顺序保证「新版到位之前旧版不消失」：新文件先写进对象存储，删旧对象和换行在之后；进程在中途崩溃，事件重投时从头再走一遍，每一步都幂等。新版一个文件也没交出时不替换，上一版保留，日志告警。

## 3. 修订任务怎么做

- **素材**：一个任务最多 20 份素材。上一版交付文件不超过 10 个、且放得下时，canvas 为每个文件新建一条上传记录，名字是「上一版-<原文件名>」（同名加序号），对象键直接指向成果对象，不复制字节；放不下时（如网页应用有几十个文件）打成一个「上一版成果.zip」（按同步路径排列，复制一份）。这些上传记录都标明来源任务（`source_task_id`）。harness 按原有素材流程放进沙箱的 `materials/`。上一版的原始素材（用户当初上传的）一并带上，修改消息里新附的文件也是素材；三者合计仍超过 20 份时拒绝发起，提示少附几个文件。
- **任务单**：代码在上一版任务单上追加：一条有来源的要求（来源类型 `revision`，原话就是用户的修改意见，每条批注一行）；一条限制「只改修改意见涉及的地方，其余与上一版一致」；素材列表加上「上一版-…」。不调用模型，不重新问需求。
- **说明（brief）**：在上一版说明后追加「## 本次是修改」：上一版文件与素材名的对照表、修改意见原话、批注（编号、位置、内容）、「新版必须交齐全部交付物，没要求改的文件从 materials/ 原样复制到交付位置」。总长仍受 20,000 字限制，超出时截短上一版说明的后部（开头是用户最初的需求，保留），不截修改部分。
- **规划和执行**：不改规划员和节点的代码，它们照常读说明和素材。复用多少由规划员决定（可以只排一个「复制并修改」节点）。整体验收照常对照任务单，包括新加的修改要求。
- **花费**：照常预估、照常「超过预估 3 倍暂停」。修改的花费记在修订任务上。

## 4. 契约

**task**
- `CreateTaskBody.revisionOf?: uuid`；`TaskBody.revisionOf: uuid | null`；`TaskSummary` 同样带上。
- `RequirementSource` 增加 `{kind: 'revision', quote}`。
- 建修订任务的检查：上一版存在、同一个人、已成功（succeeded）；同一份上一版同时只能有一个没结束的修订任务（数据库部分唯一索引兜底，冲突返回 409）。
- `DELETE /v1/tasks/:taskId`：只能删已结束的任务（succeeded / failed / cancelled），有进行中的修订时 409。
- `POST /internal/tasks/:taskId/retire {replacedBy}`：只有 `replacedBy` 的 `revisionOf` 等于它、且新版已成功时才删。已经删过的返回成功（幂等）。
- 删除 = 在一个事务里删掉任务（节点、连线、运行、花费记录级联删除），同时往发件箱写 `task.task.deleted`。之后迟到的结算事件、运行结束事件找不到任务就忽略（现有代码已如此，补测试）。

**事件** `task.task.deleted`：`{taskId, ownerId, conversationId, replacedBy: uuid | null, deletedAt}`。

**canvas**
- `POST /internal/revisions/materials {ownerId, taskId, room}` → `{materials: Material[], files: [{material, path, deliverable}]}`；`room` 是还能放几份素材，决定逐个交还是打包。
- `ArtifactBody` 增加 `replacesSha256?: string | null`（新版同一路径上旧文件的摘要，桌面端判断能不能覆盖）。「正在修改」不进表：前端从任务列表里 `revisionOf` 等于这个任务、且还没结束的修订任务得出。
- 消费 `task.task.deleted`：删除这个任务的成果行和对象、以及来源是这个任务的修订素材。下一次再改新版时，conversation 先向 canvas 核对新版的素材，已删掉的（上一轮的「上一版-…」）不再带上。
- 5.11b 再加：`artifacts.annotations jsonb`、`approved_at`，`GET/PUT /v1/artifacts/:id/annotations`、`POST/DELETE /v1/artifacts/:id/approval`。

**conversation**
- `POST /v1/conversations/:id/revisions`：`{taskId, request: 1–8000 字, annotations: [] (5.11a 为空), attachments: uuid[]}`，返回新增的消息。会话必须是这个人的私聊。
- `TaskCard`、`DeliveryCard` 增加可选的 `removed: {replacedBy: uuid | null}`。
- 消费 `task.task.deleted`：把这个任务的任务卡、交付消息、提醒都标上 `removed`。

**harness**：消费 `task.task.deleted`：停掉这个任务的预览会话；删除它全部运行的产出包和会话存档，再删运行记录（运行事件级联删除）。还没结束的运行（理论上没有）先跳过并告警，下次重投再删。

**desktop**：`beginSyncedFile(..., replacesSha256?)`：目标文件已存在且摘要等于 `replacesSha256` 时覆盖；否则存为「名字 (新版).扩展名」（已存在再加序号）。旧调用不带这个参数时行为不变。

## 5. 数据库

- task：`tasks.revision_of uuid`（可空）；部分唯一索引 `tasks_one_active_revision on tasks (revision_of) where revision_of is not null and status in ('planning','running','accepting','stopped','needs_attention')`。phase: expand，只新增可空列和索引，旧数据全部合法，没有旧结构需要收缩。
- canvas：`uploads.source_task_id uuid`（可空，加索引）、`artifacts.replaces_sha256 text`（可空）。phase: expand，同上。删除任务时删掉 `source_task_id` 是它的上传记录；对象键在 `uploads/` 下的（打包的）一并删对象，指向成果对象的随成果删除。5.11b 的批注列另起迁移。
- 不新增表。删除走级联外键（task 的节点、连线、运行、花费记录已是 `on delete cascade`；harness 的运行事件同样级联）。

## 6. 拆分

| 子步 | 内容 |
|---|---|
| 5.11a 修改闭环 | §2 的整条链：发起修改（文字意见、可附文件、选发给谁）、修订任务、整体替换、删除成果（含工作流与中间产物）、旧卡片标记、桌面端覆盖规则；成果页「发给 AI 修改」「删除」 |
| 5.11b 批注与批准 | 图片、PDF 页、视频暂停帧上圈画和编号点，时间轴红点；批注存 canvas、默认隐藏；发送时附带标注截图；「已批准」记号 |
| 5.11c 参数面板 | 播放器和 3D 预览的观看控制；音视频、3D 的成品参数表单生成结构化修改意见 |

5.11 整体完成前，用真实模型做一例修改验收（图片或文档，约 $0.1–0.3），先报预算、用户同意再测。

## 7. 风险与边界

- 修订素材和上一版成果共用对象。替换和删除时，canvas 先删除来源是这个任务的修订素材行，再删对象；修订任务已结束（或已删除）后才会发生，所以不会删掉正在用的素材。「同时只改一版」保证不会有两个修订任务共用同一批对象。
- 新版和上一版的文件路径完全一样时，直接沿用同步路径；新版多出或少了文件的，多出的照常起名，少了的随旧版删除。
- 「已删除」不等于供应商侧也删除：已经交给外部供应商的输入（如生图提示词、渲染暂存）按各自的保留策略处理，暂存对象已有清理。model-gateway 的工具结果文件（`tool-results/`）本步不清理，记为遗留项。
- 删除是不可恢复的；接口只接受已结束的任务，前端二次确认。

## 8. 5.11a 实施记录（2026-10-31，Claude）

按 §1–§5 实现了修改闭环、整体替换和删除。和设计不同的地方：

- 修订素材的上限按 §3 修订后的规则（不超过 10 个逐个交，否则打成一个 ZIP），记录来源用 `source_task_id`。
- 修订说明超长时截掉上一版说明的后部，开头（用户最初的需求）保留。
- 交付消息上加了「改一版」按钮（和成果页的「发给 AI 修改」是同一个对话框）；交付文字里「告诉我怎么改」的提示改为指向这个按钮，因为直接在私聊里说会被当成新任务。
- canvas 的 `/internal/uploads/lookup` 增加 `partial`，供再改新版时筛掉已删除的修订素材。

**改动**：contracts（task、canvas、conversation、events、desktop）；task（迁移 `add_revision_of`、建修订任务的检查、`DELETE /v1/tasks/:id`、`POST /internal/tasks/:id/retire`、`task.task.deleted`）；canvas（迁移 `revision_sources`、修订素材接口、新版替换、删除消费者）；conversation（新增 `revision-service.ts`、`POST /v1/conversations/:id/revisions`、卡片标记消费者）；harness（删除消费者：停预览、删运行存档和记录）；desktop（新版覆盖规则）；web（新增 `RevisePanel.tsx`，成果页「发给 AI 修改」「删除」，交付消息「改一版」，被替换 / 删除的卡片）。共 50 个路径，其中新增 6 个：本 ADR、两个迁移、`revision-service.ts` 及其测试（修订与接需求是不同职责，接需求要问模型、修订不问）、`RevisePanel.tsx`（成果页和私聊共用）。没有新增服务、表或依赖。

**验证**：
- 全仓 typecheck 与测试（turbo 27 项任务）通过；新增 17 项测试，覆盖修订检查、替换与幂等、删除与迟到事件、修订素材与打包、任务单与说明拼装、卡片标记、桌面覆盖、前端「改一版」和被替换卡片。
- ESLint、Prettier、`pnpm check:engineering` 七项、全仓构建通过。
- 在真实 PostgreSQL + NATS 上启动 task、canvas、conversation、harness，两个迁移按序执行；用手工插入的数据走了 15 项核验（部分唯一索引、正在修改时禁删、新版没交付不能替换、修订素材、替换与重复替换、级联删除、发件箱事件、三个消费者送达并处理、别人删不了、用户删除），全部通过，服务日志无错误。没有调用模型，费用 $0。

**还没做**：
- 真实模型下的一次修改验收（§6，约 $0.1–0.3），要先报预算、用户同意再测。
- 页面没有在浏览器里截图核对，目前只有组件测试。
- 5.11b 批注与「已批准」、5.11c 参数面板。
- model-gateway 的工具结果文件不随任务删除（§7 已列）。
