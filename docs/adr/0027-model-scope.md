# ADR 0027：「只用国内模型」开关

状态：已采纳（用户 2026-11-10 确认）

## 1. 背景

- 开发机所在的网络里，国外厂商的模型（Claude、GPT、Gemini……）经 OpenRouter 调用会被按地区拒绝。之前靠调用记录自动排除：某个型号最近一次调用因地区被拒，之后给规划员的模型目录和工具的型号列表里就不再列它（ADR 0005、0006）。
- 这套做法只能事后补：2026-11-10 的 3D 任务里，规划员给看图工具挑了 `google/gemini-4-argon`，它之前没被调用过，所以没被排除，节点调用时才被拒。而且换了网络以后，被排除的型号因为不再被调用，也回不来。
- 用户要一个自己能控制的开关，方便在两种网络下测试。

## 2. 决定

1. **一个按账号记住的开关「只用国内模型」**，在私聊输入框的「＋」菜单里，点一下开、再点一下关。默认关。
   - 开：给这个用户的 AI 团队列出的模型（规划员的模型目录、编辑节点时能选的模型、报价）和各工具的型号（规划员看到的工具目录、沙箱里 `oasis-tool list`）都只留国内厂商的。型号全是国外厂商的工具（如语音转写）整个不可用。调用工具时点名国外型号、或工具没有国内型号，调供应商之前就拒绝（409 `model_out_of_scope`），不冻结额度。
   - 关：不排除任何模型。原来「报过地区错误就自动排除」的做法取消。
2. **只管经 OpenRouter 调用的模型**（ID 是「厂商/型号」）。不按模型厂商分的工具不受影响：联网搜索（Tavily）、云渲染（Runpod）、音乐和 3D 生成（FAL）、浏览器检查、沙箱里的本地操作。
3. **哪些算国内**：国内厂商的名单在 model-gateway 的配置 `DOMESTIC_MODEL_VENDORS`（模型 ID 里「/」前面的部分，默认 deepseek、qwen、alibaba、moonshotai、bytedance、bytedance-seed、kwaivgi、minimax、stepfun、tencent、xiaomi、z-ai）；不在名单里的都算国外。
4. **不管的地方**：
   - 私聊里和哪个 AI 聊是用户自己选的，不受开关影响。
   - 平台自己的调用（规划员型号、报价草案、Jev 轻量判断、关卡）用的是配置里的型号，不受开关影响。
   - 开关只影响之后列出的模型；已经排好的节点用什么模型不变。
   - 对话模型的调用本身不拦：开关管的是「列给 AI 团队挑的清单」和工具型号的选择。沙箱里 dsh 的模型能力表（`in/.oasis-models.json`）是给 dsh 认型号能力用的，不是给节点挑模型的清单，不过滤。
   - `jev.decide` 工具的型号（`typesafe/jev-1.14`）不在国内名单里，打开后这个工具不列给 AI 团队；平台自己的 Jev 判断不受影响。
5. **保留的兜底**（和开关无关，网络受限时让任务照样走得下去）：
   - 节点运行碰上「地区不可用」换成默认模型接着做（ADR 0005）。
   - 私聊的 AI 在当前网络用不了时，接需求事先改用 `INTAKE_FALLBACK_MODEL`；专用决策模型用不了时 Jev 判断走回退。这两处仍按调用记录判断（`GET /internal/v1/models/unavailable`）。

## 3. 怎么实现

- **状态和过滤都在 model-gateway**（所有模型和工具调用本来就经过它）：
  - 表 `model_scopes(user_id, domestic_only)`，没有行就是没开。
  - `service/model-scope.ts`：读写开关，`filterFor(用户)` 给出「这个模型给不给用」。
  - 工具目录 `GET /internal/v1/tools`、能执行的模型 `GET /internal/v1/models/execution` 带 `x-oasis-payer-id` 时按这个用户过滤，不带就列全部；沙箱的 `GET /run/v1/tools` 和工具调用按临时 Key 的付费人过滤。
  - `GET / PUT /internal/v1/model-scopes/:userId` 读写开关。
- **task** 只做两件事：向 model-gateway 要目录时带上是替哪个用户要的；`GET / PUT /v1/model-scope` 替网页读写开关（gateway 不转发 model-gateway）。harness、conversation 不知道这个概念。
- **网页**：`chat/ModelScopeToggle.tsx`，「＋」菜单里的一项；切换后刷新编辑节点时能选的模型和工具。

## 4. 验证

- model-gateway：开关按用户生效、不带用户不过滤；工具目录和调用时的过滤；不按模型厂商分的工具不变。
- task：开关经 task 读写；打开后规划员说明和编辑节点的选项里没有国外模型，别的用户不受影响。
- 网页：显示当前状态，点一下开、再点一下关，读不到时不能点。
