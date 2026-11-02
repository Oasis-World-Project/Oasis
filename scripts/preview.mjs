#!/usr/bin/env node
// 用本地薄包装镜像运行不可信应用和浏览器；严格按 oasis/<组件>:<标签> 命名。
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const image = 'oasis/harness-preview:1.64.0';
if (process.argv[2] === 'accept') {
  const uid = randomUUID();
  const output = path.join(root, 'out', `preview-acceptance-${uid}`);
  await mkdir(output, { recursive: true });
  async function api(
    port,
    route,
    body,
    headers = {},
    method = body === undefined ? 'GET' : 'POST',
  ) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(70000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : undefined;
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const email = `oasis-57-${uid}@example.test`;
  await api(4101, '/v1/auth/email-code', { email });
  let message;
  for (let n = 0; n < 20 && !message; n++) {
    const found = await api(8025, `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    message = found.messages?.find((item) => item.To?.some((to) => to.Address === email));
    if (!message) await pause(500);
  }
  if (!message) throw new Error('本地验证码邮件未送达');
  const mail = await api(8025, `/api/v1/message/${message.ID}`);
  const code = mail.Text.match(/\b\d{6}\b/)?.[0];
  const signed = await api(4101, '/v1/auth/verify', { email, code });
  const payerId = signed.user.id;
  const userHeaders = { 'x-oasis-user-id': payerId };
  let wallet;
  for (let n = 0; n < 20; n++) {
    try {
      wallet = await api(4102, '/v1/wallet', undefined, userHeaders);
      break;
    } catch {
      await pause(500);
    }
  }
  if (!wallet) throw new Error('测试额度未到账');
  // 单独账号只留 $5；其余额度在本轮结束前始终冻结，包含所有模型、返工和算力。
  const reserve = await api(4102, '/internal/holds', {
    userId: payerId,
    amountMicro: wallet.availableMicro - 5000000,
    reason: '5.7 验收预算隔离',
    ref: uid,
    ttlMs: 6 * 3600000,
  });
  const tasks = [];
  const record = { payerId, reserveId: reserve.holdId, tasks, output, results: [] };
  const save = () =>
    writeFile(path.join(output, 'acceptance.json'), JSON.stringify(record, null, 2));
  await save();
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
  const cases = [
    {
      name: 'form-api',
      kind: 'node',
      entry: 'server.mjs',
      goal: '制作中文报名网页，临时 Node 后端监听 127.0.0.1 和 PORT，零依赖。首页 #name 输入姓名，#submit 提交按钮，#result 显示「谢谢，Ada」或对应姓名；#count 显示累计报名次数（初始0），实际由 POST /api/submissions 的进程内数组累加、GET /api/submissions 读取。空姓名不能提交。/about 为说明页，#back 链接回首页。往返页面后次数保持。不要持久账号或外网。',
      steps: [
        { action: 'fill', selector: '#name', text: 'Ada' },
        { action: 'click', selector: '#submit' },
        { action: 'text', selector: '#result', text: '谢谢，Ada' },
        { action: 'text', selector: '#count', text: '1' },
        { action: 'navigate', path: '/about' },
        { action: 'click', selector: '#back' },
        { action: 'fill', selector: '#name', text: 'Bob' },
        { action: 'click', selector: '#submit' },
        { action: 'text', selector: '#result', text: '谢谢，Bob' },
        { action: 'text', selector: '#count', text: '2' },
        { action: 'screenshot' },
      ],
    },
    {
      name: 'score-game',
      kind: 'static',
      entry: 'index.html',
      goal: '制作中文点击小游戏，零外网依赖，布局精致。#start 是开始按钮；#target 是标准 button，每次点击或聚焦后按 Enter 命中一次并加1分；#score 分数初始0；3分后 #status 显示「游戏结束」，不能继续加分。每次命中 AudioContext 振荡器发出250毫秒可听提示音。#restart 重开按钮，点击后分数0、状态「进行中」且可继续命中。开始后状态「进行中」。保留可操作的静态按钮，勿依赖随机位置或定时关闭靶子。',
      steps: [
        { action: 'click', selector: '#start' },
        { action: 'text', selector: '#status', text: '进行中' },
        { action: 'click', selector: '#target' },
        { action: 'text', selector: '#score', text: '1' },
        { action: 'press', selector: '#target', key: 'Enter' },
        { action: 'text', selector: '#score', text: '2' },
        { action: 'click', selector: '#target' },
        { action: 'text', selector: '#status', text: '游戏结束' },
        { action: 'click', selector: '#restart' },
        { action: 'text', selector: '#score', text: '0' },
        { action: 'text', selector: '#status', text: '进行中' },
        { action: 'click', selector: '#target' },
        { action: 'text', selector: '#score', text: '1' },
        { action: 'screenshot' },
      ],
    },
  ];
  console.log(`真实模型验收：${output}`);
  try {
    for (const scenario of cases) {
      const goal = `${scenario.goal}\n完整文件置于 out/site/。必须包含 oasis-app.json={"version":1,"kind":"${scenario.kind}","root":"site","entry":"${scenario.entry}"}。同目录交付 oasis-test.json，version=1，steps 使用以下独立验收步骤：${JSON.stringify(scenario.steps)}。测试步骤原样保留，不删除失败断言。仅使用本地文件和 Node 内置模块，禁止远程模型/工具/图片或安装依赖。完成后停止。`;
      let task = await api(4105, '/internal/tasks', {
        ownerId: payerId,
        payerId,
        title: `5.7 ${scenario.name}`,
        brief: goal,
        estimateMicro: 1500000,
        plan: {
          nodes: [
            {
              key: 'build',
              kind: 'work',
              title: scenario.name,
              model: 'deepseek/deepseek-v4.1-flash',
              goal,
              checks: [],
              expects: ['site/oasis-app.json', 'site/oasis-test.json', `site/${scenario.entry}`],
              deliver: ['site/**'],
            },
          ],
          edges: [],
        },
      });
      tasks.push(task.id);
      await save();
      const deadline = Date.now() + 12 * 60000;
      let prior = '';
      while (!['succeeded', 'failed', 'cancelled'].includes(task.status)) {
        if (Date.now() > deadline) throw new Error('真实任务超过12分钟，停止验收');
        wallet = await api(4102, '/v1/wallet', undefined, userHeaders);
        if (wallet.spentThisMonthMicro + wallet.heldMicro - reserve.heldMicro > 5000000)
          throw new Error('达到预算停止线');
        const state = `${task.status}/${task.nodes.map((node) => `${node.status}:${node.attempts}:${node.reworks}`).join(',')}`;
        if (state !== prior) {
          console.log(`${scenario.name}: ${state}`);
          prior = state;
        }
        await pause(3000);
        task = await api(4105, `/internal/tasks/${task.id}`);
      }
      await writeFile(
        path.join(output, `${scenario.name}-task.json`),
        JSON.stringify(task, null, 2),
      );
      if (task.status !== 'succeeded')
        throw new Error(`${scenario.name} 真实任务失败：${JSON.stringify(task.attention)}`);
      const node = task.nodes[0];
      const dir = path.join(output, scenario.name);
      await mkdir(dir, { recursive: true });
      const files = [];
      for (const file of node.outputs.filter((file) => file.path.startsWith('site/'))) {
        const response = await fetch(
          `http://127.0.0.1:4105/internal/tasks/${task.id}/files/${node.id}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        );
        if (!response.ok) throw new Error('任务交付文件下载失败');
        const content = Buffer.from(await response.arrayBuffer());
        const relative = file.path.slice(5);
        const dest = path.resolve(dir, relative);
        if (!dest.startsWith(dir + path.sep)) throw new Error('产物路径越界');
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, content);
        files.push({ path: relative, content });
      }
      const gate = await api(
        4105,
        `/v1/tasks/${task.id}/nodes/${node.id}/application-check`,
        undefined,
        userHeaders,
      );
      await writeFile(path.join(dir, 'platform-check.json'), JSON.stringify(gate));
      const box = await executor.start({
        id: randomUUID(),
        kind: scenario.kind,
        entry: scenario.entry,
        files,
      });
      try {
        await box.ready();
        const result = await box.test({ version: 1, steps: scenario.steps });
        await pause(700);
        const diagnostics = box.diagnostics();
        const chunks = box.audio(-1);
        if (scenario.kind === 'static' && !chunks.length) throw new Error('游戏交互后没有音效证据');
        if (chunks.length) {
          await writeFile(
            path.join(dir, 'audio.webm'),
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.webmBase64, 'base64'))),
          );
          const audioContainer = `oasis-preview-audio-${uid}`;
          let decoded;
          try {
            decoded = spawnSync(
              'docker',
              [
                'run',
                '-i',
                '--name',
                audioContainer,
                '--rm',
                '--pull',
                'never',
                '--network',
                'none',
                '--cap-drop',
                'ALL',
                '--security-opt',
                'no-new-privileges',
                '--entrypoint',
                'ffmpeg',
                'oasis/harness-sandbox-base:0.2.1-rc.5',
                '-hide_banner',
                '-i',
                'pipe:0',
                '-af',
                'astats=metadata=1:reset=0',
                '-f',
                'null',
                '-',
              ],
              {
                input: Buffer.concat(
                  chunks.map((chunk) => Buffer.from(chunk.webmBase64, 'base64')),
                ),
                encoding: 'utf8',
                timeout: 30000,
              },
            );
          } finally {
            spawnSync('docker', ['rm', '-f', audioContainer], { stdio: 'ignore' });
          }
          await writeFile(path.join(dir, 'audio-check.txt'), decoded.stderr);
          if (decoded.status !== 0 || !/RMS level dB: -\d/.test(decoded.stderr))
            throw new Error('游戏音效解码失败或静音');
        }
        for (const shot of result.screenshots)
          await writeFile(path.join(dir, shot.name), Buffer.from(shot.base64, 'base64'));
        await writeFile(
          path.join(dir, 'independent-check.json'),
          JSON.stringify({ ...result.report, diagnostics }, null, 2),
        );
        if (!result.report.passed || diagnostics.length || !gate.report?.passed)
          throw new Error(`${scenario.name} 独立验收失败`);
        record.results.push({
          name: scenario.name,
          taskId: task.id,
          passed: true,
          steps: result.report.steps.length,
          audioChunks: chunks.length,
        });
        await save();
        console.log(`${scenario.name}: 独立验收通过`);
      } finally {
        await box.destroy();
      }
    }
  } finally {
    for (const id of tasks) {
      const task = await api(4105, `/internal/tasks/${id}`);
      if (!['succeeded', 'failed', 'cancelled'].includes(task.status))
        await api(4105, `/v1/tasks/${id}/cancel`, {}, userHeaders);
    }
    wallet = await api(4102, '/v1/wallet', undefined, userHeaders);
    record.spentMicro = wallet.spentThisMonthMicro;
    await save();
    await api(4102, `/internal/holds/${reserve.holdId}/release`, {});
    console.log(`本轮已结算：$${(record.spentMicro / 1000000).toFixed(6)}`);
  }
  process.exit(0);
}
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
      files: [
        {
          path: 'index.html',
          content: Buffer.from(`${html}<script>
            const animation = document.querySelector('button').animate(
              [{ opacity: 1 }, { opacity: 0.5 }], { duration: 60000 });
            animation.onfinish = () => console.error('截图提前结束了动画');
            Promise.all([
              fetch('/nested/').then(async r => {
                if (r.status !== 200 || await r.text() !== 'nested page')
                  throw new Error('子目录未返回自己的首页');
              }),
              fetch('/client-route').then(async r => {
                if (r.status !== 200 || !(await r.text()).includes('Preview smoke'))
                  throw new Error('SPA路由未返回入口');
              })
            ]).catch(e => console.error(e.message));
          </script>`),
        },
        { path: 'nested/index.html', content: Buffer.from('nested page') },
      ],
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
      const checked = await box.test({
        version: 1,
        steps: [
          { action: 'visible', selector: 'button' },
          { action: 'text', selector: 'button', text: 'click' },
          { action: 'count', selector: 'button', count: 1 },
          { action: 'screenshot' },
        ],
      });
      if (!checked.report.passed || checked.screenshots.length !== 1)
        throw new Error('交互断言或截图未通过');
      const failed = await box.test({
        version: 1,
        steps: [
          { action: 'text', selector: 'button', text: '不存在的内容' },
          { action: 'click', selector: 'button' },
        ],
      });
      if (
        failed.report.passed ||
        failed.report.steps[1].status !== 'unchecked' ||
        failed.screenshots.length !== 1
      )
        throw new Error('失败断言没有保留证据或没有停止后续操作');
      console.log(`预览烟测通过：${test.kind}，收到画面、点击响应和声音片段`);
    } finally {
      await box.destroy();
    }
  }
  const { createWebsiteFetch } = await import('../services/harness/dist/executor/website-fetch.js');
  const website = await executor.start({
    id: randomUUID(),
    kind: 'website',
    entry: 'index.html',
    files: [],
    website: { url: 'https://example.com/', fetch: createWebsiteFetch(['https://example.com']) },
  });
  try {
    await website.ready();
    const result = await website.test({
      version: 1,
      steps: [
        { action: 'text', selector: 'title', text: 'Example Domain' },
        { action: 'screenshot' },
      ],
    });
    if (
      !result.report.passed ||
      result.screenshots.length !== 1 ||
      result.report.target !== 'website'
    )
      throw new Error(
        `外站代理断言或截图失败：${JSON.stringify(result.report)}，截图 ${result.screenshots.length}`,
      );
    console.log('外站烟测通过：禁网浏览器经固定公网地址代理读取 example.com，并执行断言和截图');
  } finally {
    await website.destroy();
  }
  process.exit(0);
}
throw new Error(
  '用法：node scripts/preview.mjs build|smoke|android-smoke|accept（accept 会产生模型费用）',
);
