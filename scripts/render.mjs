#!/usr/bin/env node
// Cloud-render preparation only. Never prints credentials or starts/publishes cloud resources.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fixedDir } from './run-dirs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, '.env');
const env = { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
const command = process.argv[2];
if (command !== 'config') {
  localImageCommand(command);
  process.exit(0);
}
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

function localImageCommand(action) {
  if (!['build', 'check', 'tag'].includes(action))
    throw new Error('用法：node scripts/render.mjs config|build|check|tag（不发布、不创建云资源）');
  const releaseFile = path.join(root, 'infra/render-release.json');
  const release = JSON.parse(readFileSync(releaseFile, 'utf8'));
  const expected = 'ghcr.io/' + env.RENDER_GHCR_NAMESPACE + '/oasis/harness-render';
  if (
    release.version !== 1 ||
    release.registry !== 'ghcr.io' ||
    release.repository !== expected ||
    !/^ghcr\.io\/[a-z0-9]+(?:-[a-z0-9]+)*\/oasis\/harness-render$/.test(release.repository) ||
    !/^oasis\/harness-render:(?!latest$)[a-z0-9][a-z0-9.-]+$/.test(release.localImage) ||
    release.remoteTag !== release.repository + ':' + release.localImage.split(':')[1] ||
    release.privateRequired !== true ||
    release.platform !== 'linux/amd64'
  )
    throw new Error('云镜像发布描述与 registry/仓库/命名白名单不符');
  // 证据在 .tmp/render-worker/：后面的步骤读前面写的 source.json，固定一个目录、每次覆盖
  const evidence = fixedDir('render-worker');
  const metadata = path.join(evidence, 'build.json');
  const receiptFile = path.join(evidence, 'local-check.json');
  const run = (args, capture = false) => {
    const result = spawnSync('docker', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      timeout: 1200000,
    });
    if (result.status !== 0) throw new Error('Docker ' + args[0] + ' 失败');
    return result.stdout;
  };
  const sources = [
    'infra/images/harness-render/Dockerfile',
    'infra/images/harness-render/Dockerfile.dockerignore',
    'services/harness/sandbox/geometry.py',
    'services/harness/render/requirements.txt',
    'services/harness/render/isolate.c',
    'services/harness/render/render_child.py',
    'services/harness/render/worker.py',
    'services/harness/test/render-worker.py',
  ];
  const sourceHash = () => {
    const hash = createHash('sha256');
    for (const name of sources) hash.update(name).update(readFileSync(path.join(root, name)));
    return hash.digest('hex');
  };
  if (action === 'build') {
    const before = sourceHash();
    run([
      'build',
      '--platform',
      release.platform,
      '--metadata-file',
      metadata,
      '-t',
      release.localImage,
      '-f',
      'infra/images/harness-render/Dockerfile',
      '.',
    ]);
    if (before !== sourceHash()) throw new Error('构建过程中源文件改变，请重新构建');
    writeFileSync(
      path.join(evidence, 'source.json'),
      JSON.stringify({ hash: sourceHash() }, null, 2),
    );
    return;
  }
  const image = JSON.parse(run(['image', 'inspect', release.localImage], true))[0];
  const build = JSON.parse(readFileSync(metadata, 'utf8'));
  const digest = build['containerimage.digest'];
  const source = JSON.parse(readFileSync(path.join(evidence, 'source.json'), 'utf8'));
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    !(
      image.Descriptor?.digest === digest ||
      (build['containerimage.config.digest'] && build['containerimage.config.digest'] === image.Id)
    ) ||
    image.Architecture !== 'amd64' ||
    image.Os !== 'linux' ||
    image.Config.User !== '10001:10001' ||
    source.hash !== sourceHash()
  )
    throw new Error('镜像摘要/平台/身份/源文件已改变，请重新构建与验证');
  if (action === 'check') {
    const checkArgs = [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--pids-limit',
      '256',
      '--mount',
      'type=bind,source=' + evidence + ',target=/evidence',
      '--mount',
      'type=bind,source=' +
        path.join(root, 'services/harness/test/render-worker.py') +
        ',target=/test.py,readonly',
      '-e',
      'RENDER_TEST_OUTPUT=/evidence',
      '-e',
      'RUNPOD_API_KEY=canary-not-real-key',
    ];
    run([...checkArgs, release.localImage, 'python', '-B', '/test.py']);
    run([
      ...checkArgs,
      '--mount',
      'type=tmpfs,destination=/usr/local/nvidia/lib64,tmpfs-mode=1777',
      '--mount',
      'type=bind,source=' +
        path.join(root, 'services/harness/test/render-worker.py') +
        ',target=/opt/oasis/render_child.py,readonly',
      release.localImage,
      'python',
      '-B',
      '/test.py',
      '--driver-loader-test',
    ]);
    writeFileSync(
      receiptFile,
      JSON.stringify(
        { imageId: image.Id, digest, source: source.hash, localPassed: true, gpuTested: false },
        null,
        2,
      ),
    );
    return;
  }
  const check = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (
    !check.localPassed ||
    check.imageId !== image.Id ||
    check.digest !== digest ||
    check.source !== source.hash
  )
    throw new Error('必须对同一源码/同一镜像完成本地检查，才能打远端标签');
  if (env.RENDER_IMAGE_DIGEST && env.RENDER_IMAGE_DIGEST !== digest)
    throw new Error('RENDER_IMAGE_DIGEST 与已核验摘要不一致');
  run(['tag', release.localImage, release.remoteTag]);
  const tagged = JSON.parse(run(['image', 'inspect', release.remoteTag], true))[0];
  if (tagged.Id !== image.Id) throw new Error('标签回读不一致');
  const plan = {
    ...release,
    imageId: image.Id,
    allowedDigest: digest,
    immutableReference: release.repository + '@' + digest,
    source: source.hash,
    localValidated: true,
    gpuValidated: false,
    published: false,
    privateRegistryValidated: false,
    publicationAuthorized: false,
    note: '仅在本地打标签；发布前必须重新核对该描述、摘要和私有性，不等于发布或部署授权。',
  };
  writeFileSync(path.join(evidence, 'release-plan.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
}
