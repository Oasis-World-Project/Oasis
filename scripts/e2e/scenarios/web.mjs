// 回归场景（docs/engineering/回归测试.md）：网页：浏览器关卡、测试计划、应用清单。
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, work } from './shared.mjs';

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
  plan: ({ pick }) => ({
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
        // 交回前自查：沙箱带着 out/site 的文件经网关交给 inspector，跑和关卡同一套浏览器检查（ADR 0024）
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
  plan: ({ pick }) => ({
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
  plan: ({ pick }) => ({
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
