#!/usr/bin/env node
// 本地编排的统一入口：固定 env 文件、compose 文件和 profile，并把当前 git 提交号注入镜像。
// 用法：node scripts/compose.mjs up [--services] | down [-v] | ps | logs [服务名…]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [command, ...rest] = process.argv.slice(2);
if (!['up', 'down', 'ps', 'logs'].includes(command)) {
  console.error('用法：node scripts/compose.mjs up [--services] | down [-v] | ps | logs [服务名…]');
  process.exit(2);
}
if (!existsSync(path.join(ROOT, '.env'))) {
  console.error('缺少 .env，请先运行 pnpm env:init');
  process.exit(1);
}

const withServices = rest.includes('--services');
const extra = rest.filter((arg) => arg !== '--services');
const commit =
  spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout?.trim() || 'unknown';

// up 默认只起中间件；down / ps / logs 总是带上服务，保证能看到、停掉全部容器
const profile = command !== 'up' || withServices ? ['--profile', 'services'] : [];
const action =
  command === 'up' ? ['up', '-d', '--wait', ...(withServices ? ['--build'] : [])] : [command];

const result = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    '.env',
    '-f',
    'infra/compose/docker-compose.yml',
    ...profile,
    ...action,
    ...extra,
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      GIT_COMMIT: commit,
      // 全套在容器里跑时，沙箱入口代理直接转给容器里的 model-gateway（本机开发时转给宿主机）
      ...(withServices ? { SANDBOX_INGRESS_UPSTREAM: 'http://model-gateway:4108' } : {}),
    },
  },
);
process.exit(result.status ?? 1);
