#!/usr/bin/env node
// inspector 的检查浏览器（ADR 0024）：构建镜像、本机烟测；顺带放着 Android 云真机的免费烟测。
// 镜像严格按 oasis/<组件>:<标签> 命名。
//   pnpm browser:build                     构建 oasis/inspector-browser
//   pnpm browser:smoke                     静态网页、Node 应用按交付关卡的路子各查一遍（通过、不通过），
//                                          外站测一次 example.com（不花钱）
//   node scripts/browser.mjs android-smoke  BrowserStack 免费计划跑一次官方演示 APK
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
const root = path.resolve(import.meta.dirname, '..');
const image = 'oasis/inspector-browser:1.64.0';
if (process.argv[2] === 'android-smoke') {
  loadEnvFile(path.join(root, 'services/model-gateway/.env'));
  const { createBrowserStackClient } =
    await import('../services/model-gateway/src/adapters/browserstack.ts');
  const response = await fetch(
    'https://raw.githubusercontent.com/browserstack/python-appium-app-browserstack/82afc4a2e6751657a3f44ed3802fb101187b51bb/android/WikipediaSample.apk',
  );
  if (!response.ok) throw new Error('官方演示 APK 下载失败');
  const apk = Buffer.from(await response.arrayBuffer());
  const uploadId = randomUUID();
  const client = createBrowserStackClient({
    username: process.env.BROWSERSTACK_USERNAME,
    accessKey: process.env.BROWSERSTACK_ACCESS_KEY,
    apiUrl: process.env.BROWSERSTACK_API_URL || 'https://api-cloud.browserstack.com',
    hubUrl: process.env.BROWSERSTACK_HUB_URL || 'https://hub-cloud.browserstack.com/wd/hub',
    canvas: {
      json: async () => ({
        uploads: [
          {
            id: uploadId,
            name: 'WikipediaSample.apk',
            size: apk.length,
            sha256: createHash('sha256').update(apk).digest('hex'),
          },
        ],
      }),
      stream: async () => new Response(apk),
    },
  });
  const dir = path.join(root, '.tmp', `android-smoke-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const receipt = {
    saved: undefined,
    async save(value) {
      this.saved = structuredClone(value);
      await writeFile(path.join(dir, 'receipt.json'), JSON.stringify(value));
    },
  };
  const id = await client.start(
    {
      uploadId,
      device: 'Samsung Galaxy S23',
      osVersion: '13.0',
      steps: [
        { action: 'visible', selector: { using: 'accessibility id', value: 'Search Wikipedia' } },
        { action: 'click', selector: { using: 'accessibility id', value: 'Search Wikipedia' } },
        {
          action: 'fill',
          selector: { using: 'id', value: 'org.wikipedia.alpha:id/search_src_text' },
          text: 'BrowserStack',
        },
        {
          action: 'text',
          selector: { using: 'id', value: 'org.wikipedia.alpha:id/search_src_text' },
          text: 'BrowserStack',
        },
        { action: 'screenshot' },
      ],
    },
    randomUUID(),
    AbortSignal.timeout(90000),
  );
  await writeFile(path.join(dir, 'handle.json'), id);
  console.log(`Android 验收记录：${dir}`);
  const result = await client.check(id, receipt, AbortSignal.timeout(120000));
  if (result.state !== 'completed') throw new Error(result.error);
  for (const file of result.outcome.files)
    await writeFile(path.join(dir, file.name), Buffer.from(file.base64, 'base64'));
  console.log(JSON.stringify(result.outcome.data));
  if (!result.outcome.data.report.passed) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
if (process.argv[2] === 'build') {
  const result = spawnSync(
    'docker',
    ['build', '-f', 'infra/images/inspector-browser/Dockerfile', '-t', image, '.'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
if (process.argv[2] === 'smoke') {
  const { createDockerApi, defaultDockerSocket, packFiles } =
    await import('../packages/service-kit/dist/index.js');
  const { createBrowserExecutor } = await import('../services/inspector/src/browser/executor.ts');
  const { createBrowserChecks } =
    await import('../services/inspector/src/browser/browser-check.ts');
  const executor = createBrowserExecutor({
    docker: createDockerApi(defaultDockerSocket()),
    image,
    memoryMb: 2048,
    pidsLimit: 512,
    appPort: 3180,
  });
  await executor.check();
  // 和交付关卡同一条路：从产出包组装（静态网页套上画布的隔离框外壳）、开检查浏览器、按测试计划操作、看画面
  let outputs = [];
  const checks = createBrowserChecks({
    executor,
    sources: { open: async () => Readable.from([await packFiles(outputs)]) },
    websiteOrigins: ['https://example.com'],
    maxArchiveBytes: 200 * 1024 * 1024,
    concurrency: 1,
  });
  const html =
    '<!doctype html><title>Browser smoke</title><button style="width:300px;height:200px" onclick="document.body.style.background=\'red\'">click</button>';
  const passing = {
    version: 1,
    steps: [
      { action: 'visible', selector: 'button' },
      { action: 'text', selector: 'button', text: 'click' },
      { action: 'count', selector: 'button', count: 1 },
      { action: 'click', selector: 'button' },
      { action: 'screenshot' },
    ],
  };
  const failing = {
    version: 1,
    steps: [
      { action: 'text', selector: 'button', text: '不存在的内容' },
      { action: 'click', selector: 'button' },
    ],
  };
  const apps = [
    { kind: 'static', entry: 'index.html', files: { 'index.html': html } },
    {
      kind: 'node',
      entry: 'server.mjs',
      files: {
        'server.mjs': `import http from 'node:http'; http.createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(${JSON.stringify(html)})).listen(Number(process.env.PORT),'127.0.0.1')`,
      },
    },
  ];
  for (const app of apps) {
    const check = (plan) => {
      const files = {
        'oasis-app.json': JSON.stringify({
          version: 1,
          kind: app.kind,
          root: 'app',
          entry: app.entry,
        }),
        'oasis-test.json': JSON.stringify(plan),
        ...app.files,
      };
      outputs = Object.entries(files).map(([path, content]) => ({
        path: `out/app/${path}`,
        content: Buffer.from(content),
      }));
      return checks.checkOutputs({
        source: { url: 'http://smoke.invalid/outputs.tar' },
        manifest: 'app/oasis-app.json',
        cores: 1,
      });
    };
    const passed = await check(passing);
    // 首屏 opening.jpg 加上测试计划里那一张截图
    if (!passed.passed || passed.screenshots?.length !== 2 || passed.report?.diagnostics.length)
      throw new Error(
        `交互断言、首屏或截图未通过：${JSON.stringify({ reason: passed.reason, report: passed.report })}`,
      );
    const failed = await check(failing);
    if (
      failed.passed ||
      failed.report?.steps[1]?.status !== 'unchecked' ||
      failed.screenshots?.length !== 2
    )
      throw new Error(`失败断言没有保留证据或没有停止后续操作：${JSON.stringify(failed.report)}`);
    console.log(
      `检查浏览器烟测通过：${app.kind}，首屏、交互断言、失败证据和画面检查都正常（用时 ${passed.usage.elapsedMs} ms）`,
    );
  }
  const site = await checks.checkWebsite({
    url: 'https://example.com/',
    plan: {
      version: 1,
      steps: [
        { action: 'text', selector: 'title', text: 'Example Domain' },
        { action: 'screenshot' },
      ],
    },
    cores: 1,
  });
  if (!site.report.passed || site.screenshots.length !== 1 || site.report.target !== 'website')
    throw new Error(
      `外站代理断言或截图失败：${JSON.stringify(site.report)}，截图 ${site.screenshots.length}`,
    );
  console.log('外站烟测通过：禁网浏览器经 inspector 代取 example.com，并执行断言和截图');
  process.exit(0);
}
throw new Error('用法：node scripts/browser.mjs build|smoke|android-smoke');
