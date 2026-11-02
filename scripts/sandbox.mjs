#!/usr/bin/env node
// 沙箱构建与离线软件验收；镜像名和 dsh 版本与 harness 的默认配置一致。
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const [command] = process.argv.slice(2);
const threed = command === 'build-3d' || command === 'check-3d';
const image = threed
  ? (process.env.SANDBOX_3D_IMAGE ?? 'oasis/harness-sandbox-3d:0.2.1-rc.5-blender4.3.2')
  : (process.env.SANDBOX_IMAGE ?? 'oasis/harness-sandbox-base:0.2.1-rc.5');
if (!/^oasis\/[a-z0-9]+(?:[._-][a-z0-9]+)*:[\w][\w.-]{0,127}$/.test(image)) {
  throw new Error('SANDBOX_IMAGE 必须是 oasis/<组件>:<标签>');
}
let result;
if (command === 'build' || command === 'build-3d') {
  const base = process.env.SANDBOX_BASE_IMAGE ?? 'oasis/harness-sandbox-base:0.2.1-rc.5';
  if (
    threed &&
    (!/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(base) ||
      spawnSync('docker', ['image', 'inspect', base], { stdio: 'ignore' }).status !== 0)
  ) {
    throw new Error(
      '3D 基础镜像必须已在本机构建；先 pnpm sandbox:build，禁止拉取 Docker Hub oasis 镜像',
    );
  }
  // 镜像源只以 BuildKit secret 注入，不把 .env 或其他配置复制进镜像。
  result = spawnSync(
    'docker',
    [
      'build',
      '-f',
      threed
        ? 'infra/images/harness-sandbox-3d/Dockerfile'
        : 'infra/images/harness-sandbox-base/Dockerfile',
      '-t',
      image,
      ...(threed ? ['--build-arg', `BASE_IMAGE=${base}`] : []),
      ...(process.env.SANDBOX_PIP_INDEX_URL
        ? ['--secret', 'id=pip_index,env=SANDBOX_PIP_INDEX_URL']
        : []),
      ...(process.env.SANDBOX_NPM_REGISTRY
        ? ['--secret', 'id=npm_registry,env=SANDBOX_NPM_REGISTRY']
        : []),
      '.',
    ],
    { cwd: root, stdio: 'inherit' },
  );
} else if (command === 'check' || command === 'check-3d') {
  const name = `oasis-file-tools-check-${randomUUID()}`;
  const output = path.resolve(
    root,
    process.env.THREED_SMOKE_OUTPUT ?? `out/3d-foundation-${randomUUID()}`,
  );
  if (threed) {
    if (!output.startsWith(path.join(root, 'out') + path.sep) || existsSync(output)) {
      throw new Error('3D 验证请选择 out/ 下尚不存在的目录');
    }
    mkdirSync(output, { recursive: true });
  }
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
        threed ? '3g' : '2g',
        '--pids-limit',
        '512',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...(threed ? ['--mount', `type=bind,src=${output},dst=/workspace/evidence`] : []),
        '--entrypoint',
        'python3',
        image,
        '-',
      ],
      {
        cwd: root,
        input: readFileSync(
          path.join(
            root,
            threed
              ? 'services/harness/test/geometry-project.py'
              : 'services/harness/test/sandbox-software.py',
          ),
        ),
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: threed ? 300_000 : 180_000,
      },
    );
  } finally {
    // 超时也只清理本次随机命名的容器，绝不清理共享容器或已有镜像。
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 });
  }
} else {
  throw new Error('用法：node scripts/sandbox.mjs build|check|build-3d|check-3d');
}
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
