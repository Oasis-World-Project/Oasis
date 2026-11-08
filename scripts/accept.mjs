#!/usr/bin/env node
// 验收模式（docs/engineering/回归测试.md）：10 个服务从当前代码启动后不再跟着代码改动重启，Web 用构建好的版本。
// 验收期间改代码、改共享契约都不会打断在途的任务（2026-11-08：改契约让 pnpm dev 全部重启、丢下在途调用）；
// 要换成新代码就 Ctrl+C 后重新 pnpm accept。模型走真实供应商，花的是真钱。
// 用法：pnpm accept   （先停掉 pnpm dev；桌面端照常 pnpm desktop）
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { schemaDrift } from './e2e/schema.mjs';
import {
  createStack,
  ensureInfra,
  FIRST,
  portBusy,
  portOf,
  ROOT,
  SECOND,
  SERVICES,
  webPort,
} from './e2e/stack.mjs';

const log = (line) => console.log(`[验收] ${line}`);
const busy = [];
for (const name of SERVICES) if (await portBusy(portOf(name))) busy.push(`${name}:${portOf(name)}`);
if (await portBusy(webPort())) busy.push(`web:${webPort()}`);
if (busy.length) {
  console.error(`这些端口被占用（${busy.join('、')}）：先停掉 pnpm dev`);
  process.exit(1);
}
const run = (command) => {
  if (
    spawnSync(command, { cwd: ROOT, shell: true, stdio: 'inherit', windowsHide: true }).status !== 0
  )
    throw new Error(`命令失败：${command}`);
};
ensureInfra(log);
log('构建共享包和 Web');
run(
  'pnpm exec turbo run build --filter=./packages/* --filter=@oasis/web --output-logs=errors-only',
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = path.join(ROOT, '.tmp', 'accept', stamp);
const stack = createStack({ logDir, log });
const stop = async () => {
  log('正在停止');
  await stack.stopAll();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await stack.startAll(FIRST);
  await stack.startAll(SECOND);
  const drift = await schemaDrift();
  if (drift.length) throw new Error(`开发库表结构和迁移文件不一致：\n${drift.join('\n')}`);
  const web = await stack.startWeb('preview');
  log(
    `就绪：${web}（桌面端：pnpm desktop）。日志在 ${path.relative(ROOT, logDir)}，任务追踪：pnpm trace <任务 ID>。按 Ctrl+C 停止。`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await stack.stopAll();
  process.exit(1);
}
