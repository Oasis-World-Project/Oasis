#!/usr/bin/env node
// 沙箱构建与离线软件验收；镜像名和 dsh 版本与 harness 的默认配置一致。
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const image = process.env.SANDBOX_IMAGE ?? 'oasis/harness-sandbox-base:0.2.1-rc.2';
if (!/^oasis\/[a-z0-9]+(?:[._-][a-z0-9]+)*:[\w][\w.-]{0,127}$/.test(image)) {
  throw new Error('SANDBOX_IMAGE 必须是 oasis/<组件>:<标签>');
}
const [command] = process.argv.slice(2);
let result;
if (command === 'build') {
  // 镜像源只以 BuildKit secret 注入，不把 .env 或其他配置复制进镜像。
  result = spawnSync(
    'docker',
    [
      'build',
      '-f',
      'infra/images/harness-sandbox-base/Dockerfile',
      '-t',
      image,
      ...(process.env.SANDBOX_PIP_INDEX_URL
        ? ['--secret', 'id=pip_index,env=SANDBOX_PIP_INDEX_URL']
        : []),
      '.',
    ],
    { cwd: root, stdio: 'inherit' },
  );
} else if (command === 'check') {
  const name = `oasis-file-tools-check-${randomUUID()}`;
  try {
    result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--name',
        name,
        '--network',
        'none',
        '--cpus',
        '2',
        '--memory',
        '2g',
        '--pids-limit',
        '512',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--entrypoint',
        'python3',
        image,
        '-',
      ],
      {
        cwd: root,
        input: readFileSync(path.join(root, 'services/harness/test/sandbox-software.py')),
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 180_000,
      },
    );
  } finally {
    // 超时也只清理本次随机命名的容器，绝不清理共享容器或已有镜像。
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 });
  }
} else {
  throw new Error('用法：node scripts/sandbox.mjs build|check');
}
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
