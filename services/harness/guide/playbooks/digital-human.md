# 实时数字人

> 适用：能和人实时语音对话的虚拟角色，如客服、前台、展厅讲解员、课程助教、导览；交付一份数字人配置，用户在画布里直接和它说话。

- 交付 `out/<名字>.oasis-avatar.json`：`version:1`、`name`（≤64 字）、`language`、`avatarId`、`avatarPreviewUrl`、`voiceId`（可选）、`prompt`（人设，≤8000 字）、`openingText`（≤1000 字）、`knowledge`（`[{title,content,source}]`，单条 ≤4000 字，合计 ≤30000 字）、`handoff`（可选 `{when,message}`）、`maxMinutes`（1–15，默认 5）。
- 形象和声音用 `oasis-tool avatar.catalog --query "<英文关键词>"` 查，ID 只能用目录里有的。
- 按分钟计费。第一句要说明自己是 AI。沙箱连不上数字人服务，没法实测对话。
