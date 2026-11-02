# 旧 Oasis 会话夹具

两份日志由真正的 `@deepseek-ai/dsh@0.2.1-rc.2` 及同版本
`@deepseek-ai/dsh-session` 生成，未手工拼造或改写事件。
仅包含合成文本、合成供应商响应和本地命令，不含用户数据或凭据。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| legacy-completed.jsonl.zstd | 6231 | 12c5651798c103bc0149364765c97960ba18fce2b5fb355a1d1df93091f7f7c7 |
| legacy-truncated.jsonl.zstd | 6236 | fbfb3395a590f01a9c3adef9f967f435aeb44e1d7827d1633214514464519210 |

生成设置：

- rc.2 官方 SDK profile，叠加提交 `895f70d` 中的 Oasis profile。
- 使用官方 stdio JSON-RPC `initialize`、`session/prompt`、`session/wait`、
  `shutdown`；provider 为旧的 `oasis`，model 为
  `deepseek/deepseek-v4.1-flash`，Session ID 为 `legacy-root`，cwd 为 `/workspace`。
- 供应商是断网容器内的回环 HTTP/SSE 夹具，没有真实模型调用。
- 用户消息为 `LEGACY_CANONICAL_HISTORY_7e82. Write legacy.txt exactly once, remember that existing work, then work on the remaining deliverable.`
- 第一条供应商响应调用原生 `bash`：
  `mkdir -p out; printf 'legacy-file-kept' > out/legacy.txt; printf 'LEGACY_TOOL_DURABLE_7e82'`。
- 第二条响应正文为 `Partial old answer; task is not complete.`，分别以
  `stop` 和 `length` 结束；原生持久化终态分别为 `completed` 和 `max-tokens`。
- 关闭 SDK 后，原样复制
  `sessions/--workspace--/legacy-root/session.v4.jsonl.zstd`。V4 是 rc.2 的实际输出格式。
  锁文件不属于测试历史，生产恢复已有独立的锁文件过滤验证。

运行回归：先构建生产 rc.5 镜像，再为 `native.test.ts` 显式设置
`OASIS_NATIVE_IMAGE=oasis/harness-sandbox-base:0.2.1-rc.5`。
测试通过真实 rc.5 读取这些字节，验证原身份、历史工具结果、旧文件、持续目标与
跨模型委派；接着把新归档再恢复一次，确认不会重复授权或扩大路由集合。
同时检查原夹具字节和恢复后日志的历史前缀不变。
