#!/usr/bin/env node
// Cloud-render preparation only. Never prints credentials or starts/publishes cloud resources.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, '.env');
const env = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
if (process.argv[2] !== 'config')
  throw new Error('用法：node scripts/render.mjs config（仅本地配置核对）');
const required = [
  'RUNPOD_API_KEY',
  'RENDER_GHCR_NAMESPACE',
  'RENDER_GHCR_PUSH_TOKEN',
  'RENDER_GHCR_PULL_TOKEN',
  'RENDER_STAGING_S3_ENDPOINT',
  'RENDER_STAGING_S3_BUCKET',
  'RENDER_STAGING_S3_ACCESS_KEY',
  'RENDER_STAGING_S3_SECRET_KEY',
];
const missing = required.filter((key) => !env[key]?.trim());
const problems = [];
const namespace = env.RENDER_GHCR_NAMESPACE?.trim();
if (namespace && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace))
  problems.push('RENDER_GHCR_NAMESPACE 必须是小写的自有 GitHub 用户/组织名');
let storageHost;
if (env.RENDER_STAGING_S3_ENDPOINT) {
  try {
    const url = new URL(env.RENDER_STAGING_S3_ENDPOINT);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname === 'localhost' ||
      !url.hostname.includes('.') ||
      /^\d+(\.\d+){3}$/.test(url.hostname)
    )
      throw new Error('Invalid cloud endpoint');
    storageHost = url.hostname;
  } catch {
    problems.push('RENDER_STAGING_S3_ENDPOINT 需要不含凭据的云端 HTTPS 地址');
  }
}
if (
  env.RENDER_STAGING_S3_BUCKET &&
  !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.RENDER_STAGING_S3_BUCKET)
)
  problems.push('RENDER_STAGING_S3_BUCKET 格式无效');
if (env.RUNPOD_ENDPOINT_ID && !/^[a-zA-Z0-9_-]+$/.test(env.RUNPOD_ENDPOINT_ID))
  problems.push('RUNPOD_ENDPOINT_ID 格式无效');
if (env.RENDER_IMAGE_DIGEST && !/^sha256:[a-f0-9]{64}$/.test(env.RENDER_IMAGE_DIGEST))
  problems.push('RENDER_IMAGE_DIGEST 必须是不可变 SHA-256 摘要');
console.log(
  JSON.stringify(
    {
      source: '.env（进程环境可覆盖）',
      credentials: Object.fromEntries(
        required.filter((k) => /KEY|TOKEN/.test(k)).map((k) => [k, Boolean(env[k]?.trim())]),
      ),
      missing,
      problems,
      imageRepository: namespace ? 'ghcr.io/' + namespace + '/oasis/harness-render' : null,
      stagingHost: storageHost ?? null,
      region: env.RENDER_STAGING_S3_REGION || 'auto',
      endpointIdConfigured: Boolean(env.RUNPOD_ENDPOINT_ID),
      imageDigestConfigured: Boolean(env.RENDER_IMAGE_DIGEST),
      preparationConfigured: missing.length === 0 && problems.length === 0,
      remoteValidated: false,
      deploymentReady: false,
      note: '只核对配置形状；账号权限、仓库私有性、R2 可达性和 GPU 隔离尚需验证，不会创建资源。',
    },
    null,
    2,
  ),
);
process.exitCode = missing.length || problems.length ? 2 : 0;
