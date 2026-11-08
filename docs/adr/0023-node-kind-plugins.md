# ADR 0023：task 引擎按节点种类拆成插件，大文件按职责拆开

状态：已采纳（执行方案阶段 2，用户 2026-11-08 确认方案）。只改结构，行为不变。

## 1. 起因

- 节点种类的分支散在引擎各处：`workflow-service.ts`（1,457 行）和 `steps.ts` 里，开跑、续跑、失败重做、收到结果、换模型、估价、规划门、用户编辑节点各自写 `if (node.kind === 'discussion')`。节点配置是一个所有种类字段混在一起的类型，讨论的发言记录和干活节点的工具清单谁都能读写。接下来要加工具节点（阶段 4）、展开和「做 N 版挑 1 版」（阶段 5），照这个写法每加一样都要把引擎改一遍。
- harness 的 `run-service.ts`（1,221 行）、model-gateway 的 `tools.ts`（1,019 行）和 `tool-service.ts`（1,002 行）一个文件管好几件事；三个服务的测试文件也有上千行的（最长 1,933 行）。

## 2. 决定

1. **每种节点一个模块**（`services/task/src/service/kinds/`），实现同一组接口 `NodeKindPlugin`（`kinds/kind.ts`）：
   - 方案和展示：自身问题、用到的型号和工具、估价、方案节点 ↔ 库里配置、用户编辑节点、工作流页的专有部分；
   - 运行：开跑、停止后继续、失败重做、接不上原会话时重新做、哪次运行算当前一步、收到结果（交出产出去过关卡，或记下这一步、开下一步）、换模型、花费提醒；
   - 两个属性：修改时能不能接着原会话改（`continuable`），运行中的追问能不能直接插进会话（`live`）。
   引擎只通过 `kindOf(node)` 拿插件，不认识具体种类。现在有 `work`（干活）和 `discussion`（讨论）两种。
2. **节点配置按种类定型。** `KindConfigs { work: WorkConfig; discussion: DiscussionConfig }`，各种节点都有的字段在 `CommonConfig`；`Node` 是按 `kind` 区分的联合类型，从库里读出来时收窄，引擎代码碰不到种类专有的字段。
3. **引擎按职责拆开**（`src/service/engine/`）：推进（`advance`）、运行结束（`finish`）、关卡和验收（`checks`）、对外的事务和副作用（`outside`）、接口返回体（`bodies`）、修改（`revisions`）。几块互相调用，共用一个后绑定的上下文对象，接口定义在 `shared.ts`，避免模块之间循环引用。对外的 `workflow-service.ts` 只管任务级操作，节点和连线的操作在 `workflow-nodes.ts`。
4. **harness、model-gateway 同样按职责拆。** harness 运行服务拆成 `service/run/`（执行、停止/取消/接管、搬文件、读产出），检查用网页的组装规则单独放 `application-bundle.ts`；model-gateway 的工具定义按类别放 `service/tools/`（检查、3D、图片、音频、联网、视频、决策），工具服务拆成上下文、长任务后台、作业接口、一次调用四块。
5. **单个文件不超过 500 行**：task、harness、model-gateway 的 `src` 和 `test` 由 ESLint `max-lines` 拦截。测试的公共部分（假服务、钩子、帮手）放 `test/support/`；测试里要改的开关和计数集中在一个对象里（`fake` / `knobs`），因为 ES 模块导出的变量在别的文件里不能赋值；被测服务要换参数重建时用 `useService` / `useTools`。

## 3. 加一种节点

1. `packages/contracts/src/task.ts`：方案节点和节点返回体加这种 `kind`；
2. `services/task/src/repo/schema.ts`：`KindConfigs` 加一行配置类型；
3. 写一个实现 `NodeKindPlugin` 的模块，在 `kinds/index.ts` 的 `KINDS` 里登记。

引擎、规划门、报价、工作流页的接口不用改；类型检查会指出漏实现的方法。

## 4. 现状

- 回归 11 个场景全过，三个服务的单元测试数和拆之前一样（task 114、harness 113、model-gateway 129）。
- 还超过 500 行的两个 harness 文件不在 ESLint 范围里：`sandbox/geometry.py`（沙箱镜像里的 3D 脚本，节点里的 AI 会读它看场景协议的字段，不拆）、`preview/controller.mjs`（检查用浏览器的控制端，阶段 3 搬进 inspector 时再拆）。
