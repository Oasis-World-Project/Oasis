#!/usr/bin/env node
// 用本地薄包装镜像运行不可信应用和浏览器；严格按 oasis/<组件>:<标签> 命名。
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const image = 'oasis/harness-preview:1.64.0';
if (process.argv[2] === 'build') {
  const result = spawnSync(
    'docker',
    ['build', '-f', 'infra/images/harness-preview/Dockerfile', '-t', image, '.'],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
if (process.argv[2] === 'smoke') {
  const { createDockerApi, defaultDockerSocket } =
    await import('../services/harness/dist/executor/docker-api.js');
  const { createPreviewExecutor } =
    await import('../services/harness/dist/executor/preview-executor.js');
  const executor = createPreviewExecutor({
    docker: createDockerApi(defaultDockerSocket()),
    image,
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 512,
    appPort: 3180,
  });
  await executor.check();
  const html =
    '<!doctype html><title>Preview smoke</title><button style="width:300px;height:200px" onclick="document.body.style.background=\'red\';const a=new AudioContext();const o=a.createOscillator();o.connect(a.destination);o.start();o.stop(a.currentTime+0.5)">click</button>';
  const cases = [
    {
      kind: 'static',
      entry: 'index.html',
      files: [{ path: 'index.html', content: Buffer.from(html) }],
    },
    {
      kind: 'node',
      entry: 'server.mjs',
      files: [
        {
          path: 'server.mjs',
          content: Buffer.from(
            `import http from 'node:http'; http.createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(${JSON.stringify(html)})).listen(Number(process.env.PORT),'127.0.0.1')`,
          ),
        },
      ],
    },
  ];
  for (const test of cases) {
    const box = await executor.start({ id: randomUUID(), ...test });
    try {
      await box.ready();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const before = box.frame();
      if (!before) throw new Error('没有得到初始画面');
      box.input({ kind: 'pointer', x: 100, y: 100, action: 'down' });
      box.input({ kind: 'pointer', x: 100, y: 100, action: 'up' });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = box.frame();
      if (!after || after.jpegBase64 === before.jpegBase64) throw new Error('点击后画面没有变化');
      if (box.audio(-1).length === 0) throw new Error('点击后没有声音片段');
      if (
        Buffer.from(box.audio(-1)[0].webmBase64, 'base64').subarray(0, 4).toString('hex') !==
        '1a45dfa3'
      )
        throw new Error('声音不是 WebM 容器片段');
      if (box.diagnostics().length) throw new Error(box.diagnostics().join('；'));
      console.log(`预览烟测通过：${test.kind}，收到画面、点击响应和声音片段`);
    } finally {
      await box.destroy();
    }
  }
  process.exit(0);
}
throw new Error('用法：node scripts/preview.mjs build|smoke');
