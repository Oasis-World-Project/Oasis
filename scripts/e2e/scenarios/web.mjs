// 回归场景（docs/engineering/回归测试.md）：网页：浏览器关卡、测试计划、应用清单。
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, outcomes, sha256, work } from './shared.mjs';

// ---------- 1. 多文件网页：浏览器关卡发现计数错 → 退回修一次 → 桌面端画布里打得开、点得对 ----------
// 脚本是 ES 模块、互相 import（11-07「检查通过的网页画布里黑屏」就是多文件模块串联引用）
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>计数器</title><link rel="stylesheet" href="style.css"></head>
<body><main><h1 id="title">计数器</h1><p>已经点了 <span id="count">0</span> 次</p>
<button id="inc" type="button">加一</button></main><script type="module" src="app.js"></script></body>
</html>`;
const STYLE =
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#f7d9c4,#c4dff7);font-family:sans-serif}' +
  'main{padding:32px 48px;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.15)}button{font-size:18px;padding:8px 20px}';
const APP_JS = `import { STEP } from './counter.js';\nlet n = 0;\ndocument.getElementById('inc').addEventListener('click', () => {\n  n += STEP;\n  document.getElementById('count').textContent = String(n);\n});\n`;
const counter = (step) => `export const STEP = ${step};\n`;
const APP = { version: 1, kind: 'static', root: 'site', entry: 'index.html' };
/** 计数网页的操作计划：#count 从 0 开始，点 #inc 加一（真模型场景也用它，需求里写明了这两个 id） */
export const PAGE_TEST = {
  version: 1,
  steps: [
    { action: 'text', selector: '#count', text: '0' },
    { action: 'click', selector: '#inc' },
    { action: 'text', selector: '#count', text: '1' },
    { action: 'click', selector: '#inc' },
    { action: 'text', selector: '#count', text: '2' },
    { action: 'screenshot' },
  ],
};

export const web = {
  title: '计数小网页',
  deliverables: [{ name: '计数网页', form: '静态网页（HTML + CSS + JS）' }],
  criteria: ['点「加一」计数加一'],
  get request() {
    return `做一个计数小网页，HTML、CSS、JS 分开放 ${marker('web')}`;
  },
  plan: ({ pick }) =>
    outcomes({
      nodes: [
        work('web', 'site', '做计数网页', '做一个计数网页，交出 out/site/ 整个目录', {
          model: pick(DEFAULT_MODEL),
          expects: ['site/index.html'],
          deliver: ['site/**'],
        }),
      ],
      edges: [],
      deliverables: { 计数网页: 'site' },
    }),
  nodes: {
    site: {
      // 第一版计数每次加 2：浏览器关卡按 oasis-test.json 点一遍会发现
      work: [
        {
          bash: writeFiles({
            'out/site/index.html': PAGE,
            'out/site/style.css': STYLE,
            'out/site/app.js': APP_JS,
            'out/site/counter.js': counter(2),
            'out/site/oasis-app.json': JSON.stringify(APP),
            'out/site/oasis-test.json': JSON.stringify(PAGE_TEST),
          }),
          description: '写网页',
        },
      ],
      rework: [
        ({ seg }) =>
          seg.text.includes('第 3 步 text #count')
            ? { bash: writeFiles({ 'out/site/counter.js': counter(1) }), description: '修计数' }
            : { text: `修复提示里没有浏览器检查发现的计数问题：${seg.text.slice(0, 200)}` },
        // 交回前自查：沙箱带着 out/site 的文件经网关交给 inspector，跑和关卡同一套浏览器检查
        { bash: 'oasis-tool app.check --dir out/site', description: '自查网页' },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '网页交付');
    const node = task.nodes[0];
    t.check(node.reworks === 1, `浏览器关卡应退回修一次，实际 ${node.reworks} 次`);
    t.check(!node.warning, `修好后不应再有提醒：${node.warning}`);
    const site = t.provider.of('web', 'site');
    const fixed = site.filter((c) => c.segment === 'rework' && c.action === 'bash:0');
    t.check(fixed.length === 1, `修复提示里应带着浏览器检查发现的问题（收到 ${fixed.length} 次）`);
    const selfCheck = site.find((c) => c.segment === 'rework' && c.action === 'done');
    t.check(
      selfCheck?.previous?.includes('浏览器检查通过'),
      `节点自查 app.check 应通过：${selfCheck?.previous ?? '没有记录'}`,
    );
    // 浏览器检查（关卡两次、节点自查一次）的算力按实际用时结算在这个任务上
    const browsed = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'compute' and model = 'application-check'`,
    );
    t.check(
      browsed.length >= 3 && browsed.every((c) => c.status === 'succeeded'),
      `浏览器检查的算力应结算在任务上（${browsed.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    // 关卡的检查报告由 task 存回 harness，用户在工作流里下载的是最后一次（修好后）的
    const report = await t.user.api.get(
      `/task/v1/tasks/${taskId}/nodes/${node.id}/application-check`,
    );
    t.check(
      report?.passed === true && report.screenshots?.some((s) => s.name === 'opening.jpg'),
      `下载的浏览器检查报告应是修好后通过的那次、带首屏截图：${JSON.stringify(report).slice(0, 200)}`,
    );
    const expected = [
      'site/app.js',
      'site/counter.js',
      'site/index.html',
      'site/oasis-app.json',
      'site/style.css',
    ];
    const artifacts = await t.user.waitArtifacts(taskId, expected);
    const paths = artifacts.map((a) => a.path).sort();
    for (const file of expected)
      t.check(paths.includes(file), `画布里缺 ${file}（有：${paths.join('、')}）`);
    const app = (await t.user.waitApplication(taskId)).find(
      (a) => a.application?.kind === 'static',
    );
    t.check(app, '画布里没有可运行的网页成果');
    const js = artifacts.find((a) => a.path === 'site/counter.js');
    if (js)
      t.check(
        (await t.user.content(js.id)).toString().includes('STEP = 1'),
        '画布里的 counter.js 不是修好后的版本',
      );
    if (app) await t.canvas(taskId, app, PAGE_TEST);
  },
};

// ---------- 1b. 测试计划放错目录：关卡要明确说出来让节点挪好，不能当成「没写测试」悄悄放过（11-07） ----------
export const testplan = {
  title: '计数小网页（测试计划放错）',
  deliverables: [{ name: '计数网页', form: '静态网页（HTML + CSS + JS）' }],
  criteria: ['点「加一」计数加一'],
  get request() {
    return `做一个计数小网页，附上浏览器测试计划 ${marker('testplan')}`;
  },
  plan: ({ pick }) =>
    outcomes({
      nodes: [
        work('testplan', 'site', '做计数网页', '做一个计数网页，交出 out/site/ 整个目录', {
          model: pick(DEFAULT_MODEL),
          expects: ['site/index.html'],
          deliver: ['site/**'],
        }),
      ],
      edges: [],
      deliverables: { 计数网页: 'site' },
    }),
  nodes: {
    site: {
      work: [
        {
          bash: writeFiles({
            'out/site/index.html': PAGE,
            'out/site/style.css': STYLE,
            'out/site/app.js': APP_JS,
            'out/site/counter.js': counter(1),
            'out/site/oasis-app.json': JSON.stringify(APP),
            'out/oasis-test.json': JSON.stringify(PAGE_TEST),
          }),
          description: '写网页（测试计划放在了 out/ 下）',
        },
      ],
      rework: [
        ({ seg }) =>
          seg.text.includes('oasis-test.json 放在了 out/oasis-test.json')
            ? { bash: 'mv out/oasis-test.json out/site/oasis-test.json', description: '挪测试计划' }
            : { text: `修复提示里没说测试计划放错了：${seg.text.slice(0, 200)}` },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '网页交付');
    const node = task.nodes[0];
    t.check(node.reworks === 1, `关卡应因为测试计划放错退回一次，实际 ${node.reworks} 次`);
    t.check(!node.warning, `挪好后不应再有提醒：${node.warning}`);
    const moved = t.provider
      .of('testplan', 'site')
      .filter((c) => c.segment === 'rework' && c.action === 'bash:0');
    t.check(moved.length === 1, `修复提示里应说清测试计划放错了目录（收到 ${moved.length} 次）`);
    const artifacts = await t.user.waitApplication(taskId);
    t.check(
      artifacts.some((a) => a.application?.kind === 'static'),
      `画布里没有可运行的网页成果（有：${artifacts.map((a) => a.path).join('、')}）`,
    );
  },
};

// ---------- 1c. 网页没配 oasis-app.json：关卡要让节点补上，不然画布里只能看源码（11-08 真模型回归） ----------
export const manifest = {
  title: '计数小网页（没写清单）',
  deliverables: [{ name: '计数网页', form: '静态网页（HTML + CSS + JS）' }],
  criteria: ['点「加一」计数加一'],
  get request() {
    return `做一个计数小网页 ${marker('manifest')}`;
  },
  plan: ({ pick }) =>
    outcomes({
      nodes: [
        work('manifest', 'site', '做计数网页', '做一个计数网页，交出 out/site/ 整个目录', {
          model: pick(DEFAULT_MODEL),
          expects: ['site/index.html'],
          deliver: ['site/**'],
        }),
      ],
      edges: [],
      deliverables: { 计数网页: 'site' },
    }),
  nodes: {
    site: {
      work: [
        {
          bash: writeFiles({
            'out/site/index.html': PAGE,
            'out/site/style.css': STYLE,
            'out/site/app.js': APP_JS,
            'out/site/counter.js': counter(1),
          }),
          description: '写网页（没写 oasis-app.json）',
        },
      ],
      rework: [
        ({ seg }) =>
          seg.text.includes('out/site/ 里没有 oasis-app.json')
            ? {
                bash: writeFiles({
                  'out/site/oasis-app.json': JSON.stringify(APP),
                  'out/site/oasis-test.json': JSON.stringify(PAGE_TEST),
                }),
                description: '补清单',
              }
            : { text: `修复提示里没说缺 oasis-app.json：${seg.text.slice(0, 200)}` },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '网页交付');
    const node = task.nodes[0];
    t.check(node.reworks === 1, `关卡应因为缺清单退回一次，实际 ${node.reworks} 次`);
    t.check(!node.warning, `补上清单后不应再有提醒：${node.warning}`);
    const fixed = t.provider
      .of('manifest', 'site')
      .filter((c) => c.segment === 'rework' && c.action === 'bash:0');
    t.check(fixed.length === 1, `修复提示里应说清缺 oasis-app.json（收到 ${fixed.length} 次）`);
    const artifacts = await t.user.waitApplication(taskId);
    t.check(
      artifacts.some((a) => a.application?.kind === 'static'),
      `补上清单后画布里应能运行（有：${artifacts.map((a) => a.path).join('、')}）`,
    );
  },
};

// ---------- 1d. 一个 AI 从头做到交付：自己调工具拿素材、做多文件网页、
// 用沙箱里的浏览器自己点一遍、再按画布的方式查一次；一次交付，关卡不退回 ----------
const COVER_PAGE = PAGE.replace(
  '<p>已经点了',
  '<img id="cover" src="cover.png" alt="插图" width="160"><p>已经点了',
);
/** 节点自己写的浏览器脚本：页面的脚本是 ES 模块，要经 http 打开，所以先在回环地址上起一个静态服务 */
const PLAY = `import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root = '/workspace/out/site';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url.slice(1);
  try {
    const body = await readFile(path.join(root, name));
    response.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:' + server.address().port + '/');
await page.click('#inc');
await page.click('#inc');
const count = await page.textContent('#count');
const cover = await page.evaluate(() => document.getElementById('cover').naturalWidth > 0);
const shot = await page.screenshot();
await browser.close();
server.close();
console.log('BROWSER ' + JSON.stringify({ count, cover, shot: shot.length > 1000 }));
`;

export const solo = {
  title: '带插图的计数网页',
  deliverables: [{ name: '计数网页', form: '静态网页（HTML + CSS + JS）' }],
  criteria: ['点「加一」计数加一', '页面上有一张插图'],
  get request() {
    return `做一个带插图的计数小网页 ${marker('solo')}`;
  },
  plan: ({ pick }) =>
    outcomes({
      nodes: [
        work(
          'solo',
          'site',
          '做带插图的计数网页',
          '做一个带插图的计数网页，交出 out/site/ 整个目录',
          {
            model: pick(DEFAULT_MODEL),
            expects: ['site/index.html', 'site/cover.png'],
            deliver: ['site/**'],
          },
        ),
      ],
      edges: [],
      deliverables: { 计数网页: 'site' },
    }),
  nodes: {
    site: {
      work: [
        {
          bash: 'oasis-tool model.ask --question "计数网页最容易漏掉什么？"',
          description: '问另一个模型',
        },
        {
          bash: 'mkdir -p out/site && oasis-tool image.generate --prompt "雨夜屋顶上的橘猫，像素风" --out out/site/cover.png && ls out/site',
          description: '生成插图',
        },
        {
          bash: writeFiles({
            'out/site/index.html': COVER_PAGE,
            'out/site/style.css': STYLE,
            'out/site/app.js': APP_JS,
            'out/site/counter.js': counter(1),
            'out/site/oasis-app.json': JSON.stringify(APP),
            'out/site/oasis-test.json': JSON.stringify(PAGE_TEST),
          }),
          description: '写网页',
        },
        {
          bash: `cat > /tmp/play.mjs <<'EOF'\n${PLAY}EOF\nnode /tmp/play.mjs`,
          description: '用沙箱里的浏览器自己点一遍',
        },
        { bash: 'oasis-tool app.check --dir out/site', description: '按画布的方式查一次' },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '网页交付');
    t.check(task.nodes.length === 1, `应只有一个干活节点，实际 ${task.nodes.length} 个`);
    const node = task.nodes[0];
    t.check(node.reworks === 0, `自己校验过的成果关卡不应退回，实际退回 ${node.reworks} 次`);
    t.check(!node.warning, `不应有提醒：${node.warning}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'image'),
      '节点没有自己调生图工具',
    );
    const site = t.provider.of('solo', 'site');
    const asked = site.find((c) => c.segment === 'work' && c.action === 'bash:1');
    t.check(
      asked?.previous?.includes('好的。'),
      `节点应能问另一个模型并拿到回答：${asked?.previous ?? '没有记录'}`,
    );
    const played = site.find((c) => c.segment === 'work' && c.action === 'bash:4');
    t.check(
      played?.previous?.includes('BROWSER {"count":"2","cover":true,"shot":true}'),
      `节点应能用沙箱里的浏览器打开自己做的页面、点两下、看到插图并截图：${played?.previous ?? '没有记录'}`,
    );
    const checked = site.find((c) => c.segment === 'work' && c.action === 'get_goal');
    t.check(
      checked?.previous?.includes('浏览器检查通过'),
      `按画布的方式自查应通过：${checked?.previous ?? '没有记录'}`,
    );
    const expected = [
      'site/app.js',
      'site/counter.js',
      'site/cover.png',
      'site/index.html',
      'site/oasis-app.json',
      'site/style.css',
    ];
    const artifacts = await t.user.waitArtifacts(taskId, expected);
    const paths = artifacts.map((a) => a.path).sort();
    for (const file of expected)
      t.check(paths.includes(file), `画布里缺 ${file}（有：${paths.join('、')}）`);
    const cover = artifacts.find((a) => a.path === 'site/cover.png');
    if (cover)
      t.check(
        sha256(await t.user.content(cover.id)) === sha256(t.fixtures.png),
        '画布里的插图和供应商给的图不一致',
      );
    const app = (await t.user.waitApplication(taskId)).find(
      (a) => a.application?.kind === 'static',
    );
    t.check(app, '画布里没有可运行的网页成果');
    if (app) await t.canvas(taskId, app, PAGE_TEST);
  },
};
