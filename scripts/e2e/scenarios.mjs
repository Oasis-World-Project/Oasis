// 回归场景（docs/engineering/回归测试.md）：每个场景 = 假供应商的脚本（任务单、方案、每个节点怎么做）
// + 用户怎么操作 + 断言。场景名就是用户原话里的标记 [[e2e:名字]]。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execute, literal, query } from './db.mjs';
import { marker, writeFiles } from './fake-provider.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro-0813';

/** 模拟持久卷被清掉（docker volume prune、换了机器）：删掉这个会话的工作目录和 dsh 会话 */
function dropWorkspace(sessionId) {
  for (const name of [`oasis-workspace-${sessionId}`, `oasis-sessions-${sessionId}`]) {
    const result = spawnSync('docker', ['volume', 'rm', name], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`删不掉持久卷 ${name}：${result.stderr.trim()}`);
  }
}

/** 方案里的一个干活节点 */
function work(scenario, key, title, goal, extra) {
  return {
    key,
    title,
    kind: 'work',
    role: '',
    goal: `${marker(scenario, key)} ${goal}`,
    model: DEFAULT_MODEL,
    tools: [],
    checks: [],
    expects: [],
    ...extra,
  };
}

const done = (task) => task.status === 'succeeded';

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

const web = {
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
const testplan = {
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
const manifest = {
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

// ---------- 2. 图文交付：生图工具 → 下游节点用上游的图写 DOCX ----------
const media = {
  title: '活动海报和说明',
  deliverables: [
    { name: '活动海报', form: 'PNG' },
    { name: '说明文档', form: 'DOCX' },
  ],
  criteria: ['海报和说明文档都交付', '说明文档里插着海报'],
  quoteTools: [{ key: 'image.generate', uses: { economy: 1, standard: 1, premium: 2 } }],
  get request() {
    return `做一张活动海报（PNG）和一份插着海报的说明文档（DOCX）${marker('media')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('media', 'poster', '画海报', '用 image.generate 生成海报，交出 out/海报.png', {
        model: pick(DEFAULT_MODEL),
        tools: [{ key: 'image.generate', uses: 1 }],
        expects: ['海报.png'],
        deliver: ['海报.png'],
      }),
      work('media', 'doc', '写说明', '用 in/poster/海报.png 写说明文档，交出 out/说明.docx', {
        model: pick(DEFAULT_MODEL),
        expects: ['说明.docx'],
        deliver: ['说明.docx'],
      }),
    ],
    edges: [{ from: 'poster', to: 'doc' }],
    deliverables: { 活动海报: 'poster', 说明文档: 'doc' },
  }),
  nodes: {
    poster: {
      work: [
        {
          bash: 'oasis-tool image.generate --prompt "秋季活动海报，暖色渐变" --out out/海报.png && ls out',
          description: '生成海报',
        },
      ],
    },
    doc: {
      work: [
        {
          bash: [
            'test -f in/poster/海报.png',
            `python3 -c "from docx import Document; from docx.shared import Inches; d = Document(); d.add_heading('活动海报说明', 1); d.add_paragraph('海报由上游节点生成。'); d.add_picture('in/poster/海报.png', width=Inches(2)); d.save('out/说明.docx')"`,
          ].join(' && '),
          description: '写说明文档',
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.user.waitTask(taskId, done, '图文交付');
    const images = t.provider.calls.filter((c) => c.kind === 'image');
    t.check(images.length >= 1, '生图工具没有调到供应商');
    const artifacts = await t.user.waitArtifacts(taskId, ['海报.png', '说明.docx']);
    const poster = artifacts.find((a) => a.path === '海报.png');
    const doc = artifacts.find((a) => a.path === '说明.docx');
    t.check(poster, '画布里没有海报');
    t.check(doc, '画布里没有说明文档');
    if (poster)
      t.check(
        sha256(await t.user.content(poster.id)) === sha256(t.fixtures.png),
        '画布里的海报和供应商给的图不一致',
      );
    if (doc) {
      const bytes = await t.user.content(doc.id);
      t.check(bytes.includes(Buffer.from('word/media/')), '说明文档里没有插图');
    }
  },
};

// ---------- 3. 修改：规划员排方案 → 用户确认 → 沿用 / 重新做 / 接着原会话改（ADR 0022） ----------
const reviseNodes = (pick) => [
  work('revise', 'copy', '写文案', '写活动文案，交出 out/文案.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['文案.md'],
    deliver: ['文案.md'],
  }),
  work('revise', 'sheet', '写海报说明', '按 in/copy/文案.md 写海报说明，交出 out/海报说明.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['海报说明.md'],
    deliver: ['海报说明.md'],
  }),
];
const revise = {
  title: '活动文案和海报说明',
  deliverables: [
    { name: '活动文案', form: 'Markdown' },
    { name: '海报说明', form: 'Markdown' },
  ],
  criteria: ['文案和海报说明标题一致'],
  get request() {
    return `写一段活动文案，再按文案写一份海报说明 ${marker('revise')}`;
  },
  plan: ({ pick }) => ({
    nodes: reviseNodes(pick),
    edges: [{ from: 'copy', to: 'sheet' }],
    deliverables: { 活动文案: 'copy', 海报说明: 'sheet' },
  }),
  // 第一次改标题：文案沿用、海报说明重新做；第二次加副标题：海报说明接着原会话改
  revisionPlan: ({ pick, request }) => {
    const [copy, sheet] = reviseNodes(pick);
    const winter = request?.includes('冬日');
    return {
      summary: winter
        ? '文案沿用，海报说明重新做，标题改成冬日市集。'
        : '文案沿用，海报说明接着原来的会话加副标题。',
      nodes: [
        { key: copy.key, reuse: copy.key },
        winter
          ? {
              ...sheet,
              goal: `${sheet.goal}；基于 in/_previous/海报说明.md 把标题改成冬日市集`,
              from: 'sheet',
              mode: 'fresh',
            }
          : { ...sheet, goal: `${sheet.goal}；加一句副标题`, from: 'sheet', mode: 'continue' },
      ],
      edges: [{ from: 'copy', to: 'sheet' }],
      deliverables: { 活动文案: 'copy', 海报说明: 'sheet' },
    };
  },
  nodes: {
    copy: { work: [{ bash: writeFiles({ 'out/文案.md': '# 秋日市集\n周末一起逛市集。\n' }) }] },
    sheet: {
      work: [
        ({ seg }) =>
          seg.text.includes('【上一版】')
            ? {
                // 重新做：上一版的文件在 in/_previous/，标题改掉
                bash: `test -f in/_previous/海报说明.md && test -f in/copy/文案.md && mkdir -p out && sed 's/秋日市集/冬日市集/' in/_previous/海报说明.md > out/海报说明.md`,
              }
            : {
                bash: `test -f in/copy/文案.md && ${writeFiles({ 'out/海报说明.md': '# 秋日市集\n海报用暖色。\n' })}`,
              },
      ],
      revision: [{ bash: `printf '%s\\n' '副标题：一起过周末' >> out/海报说明.md` }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '第一版交付');
    const sheetNode = task.nodes.find((n) => n.key === 'sheet');
    const copyCalls = () => t.provider.of('revise', 'copy').length;
    const before = copyCalls();

    // 第一次修改：改标题 → 规划员排方案 → 等确认
    await t.user.revise(taskId, { request: '把标题改成「冬日市集」', nodeIds: [sheetNode.id] });
    task = await t.user.waitTask(taskId, (x) => x.revision?.stage === 'confirm', '修改方案待确认');
    t.check(
      task.attention?.reason === 'revision_plan',
      `应等用户确认修改方案：${JSON.stringify(task.attention)}`,
    );
    const change = Object.fromEntries(task.revision.changes.map((c) => [c.key, c.change]));
    t.check(
      change.copy === 'reuse' && change.sheet === 'fresh',
      `修改方案不对：${JSON.stringify(change)}`,
    );
    await t.user.decide(taskId, 'continue');
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '第二版交付',
    );
    t.check(copyCalls() === before, '沿用的「写文案」节点不应再调模型');
    t.check(
      task.versions.some((v) => v.version === 1),
      '第一版工作流应冻结可查',
    );
    const winter = await t.user.waitContent(taskId, '海报说明.md', (text) =>
      text.includes('冬日市集'),
    );
    t.check(winter.includes('冬日市集'), `画布里的海报说明没改成冬日市集：${winter}`);
    t.check(
      (await t.user.artifacts(taskId)).length === 2,
      '修改后画布里应还是 2 个成果（原地更新，不多出一份）',
    );

    // 第二次修改：接着原会话加副标题
    await t.user.revise(taskId, { request: '加一句副标题', nodeIds: [sheetNode.id] });
    task = await t.user.waitTask(
      taskId,
      (x) => x.revision?.stage === 'confirm',
      '第二次修改方案待确认',
    );
    const change2 = Object.fromEntries(task.revision.changes.map((c) => [c.key, c.change]));
    t.check(change2.sheet === 'continue', `第二次应接着原会话改：${JSON.stringify(change2)}`);
    await t.user.decide(taskId, 'continue');
    await t.user.waitTask(taskId, (x) => done(x) && x.version === 3 && !x.revising, '第三版交付');
    const continued = t.provider.of('revise', 'sheet').filter((c) => c.segment === 'revision');
    t.check(
      continued.length > 0 && continued.every((c) => c.segments > 1),
      '接着改的节点没有接上原会话',
    );
    const third = await t.user.waitContent(taskId, '海报说明.md', (text) =>
      text.includes('副标题'),
    );
    t.check(third.includes('冬日市集') && third.includes('副标题'), `第三版海报说明不对：${third}`);
  },
};

// ---------- 4. 停止后继续：节点在跑命令时被用户停下，继续后接着原会话做完 ----------
const stop = {
  title: '慢慢做的报告',
  deliverables: [{ name: '报告', form: 'Markdown' }],
  criteria: ['交出报告'],
  get request() {
    return `写一份报告，中途我可能会停下 ${marker('stop')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('stop', 'slow', '写报告', '写报告，交出 out/报告.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['报告.md'],
        deliver: ['报告.md'],
      }),
    ],
    edges: [],
    deliverables: { 报告: 'slow' },
  }),
  nodes: {
    slow: {
      work: [
        { bash: 'mkdir -p out && echo 开始 > out/进度.txt && sleep 600', description: '慢慢做' },
      ],
      resume: [
        {
          bash: `test -f out/进度.txt && ${writeFiles({ 'out/报告.md': '# 报告\n停下后接着做完。\n' })}`,
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'stop' && c.node === 'slow' && c.action === 'bash:0',
      '节点开始跑命令',
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await t.user.stop(taskId);
    let task = await t.user.waitTask(taskId, (x) => x.status === 'stopped', '任务停下');
    t.check(task.nodes[0].status === 'stopped', `节点应是已停止：${task.nodes[0].status}`);
    await t.user.run(taskId);
    task = await t.user.waitTask(taskId, done, '继续后交付');
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.check(runs.length === 2, `应有两次运行（停下的和继续的），实际 ${runs.length} 次`);
    t.check(
      runs.some((r) => r.status === 'stopped'),
      '第一次运行应是已停止',
    );
    t.check(
      runs.some((r) => r.continued && r.status === 'succeeded'),
      '继续的那次应接着原会话并成功',
    );
    const resumed = t.provider.of('stop', 'slow').filter((c) => c.segment === 'resume');
    t.check(resumed.length > 0 && resumed.every((c) => c.segments === 2), '继续后没有接上原会话');
    const artifacts = await t.user.waitArtifacts(taskId, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 4b. 持久工作目录丢了：修改时接不上原会话，重新开会话做、带上上一版产出（ADR 0022） ----------
const noteNode = (pick) =>
  work('workspace', 'note', '写笔记', '写笔记，交出 out/笔记.md', {
    model: pick(DEFAULT_MODEL),
    expects: ['笔记.md'],
    deliver: ['笔记.md'],
  });
const workspace = {
  title: '工作目录丢失测试',
  deliverables: [{ name: '笔记', form: 'Markdown' }],
  criteria: ['交出笔记'],
  get request() {
    return `写一份笔记（之后它的工作目录会被清掉）${marker('workspace')}`;
  },
  plan: ({ pick }) => ({
    nodes: [noteNode(pick)],
    edges: [],
    deliverables: { 笔记: 'note' },
  }),
  // 规划员要接着原会话改；原会话的工作目录已经没了，task 应改成重新做
  revisionPlan: ({ pick }) => {
    const note = noteNode(pick);
    return {
      summary: '笔记接着原来的会话加一句结尾。',
      nodes: [{ ...note, goal: `${note.goal}；加一句结尾`, from: 'note', mode: 'continue' }],
      edges: [],
      deliverables: { 笔记: 'note' },
    };
  },
  nodes: {
    note: {
      work: [
        ({ seg }) =>
          seg.text.includes('【重新做】')
            ? {
                bash: `test -f in/_previous/笔记.md && mkdir -p out && cp in/_previous/笔记.md out/笔记.md && printf '%s\\n' '结尾：新会话补上的' >> out/笔记.md`,
              }
            : { bash: writeFiles({ 'out/笔记.md': '# 笔记\n第一版。\n' }) },
      ],
      // 工作目录没了，不应该再接着原会话改
      revision: [{ bash: `printf '%s\\n' '结尾：接着原会话' >> out/笔记.md` }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '第一版交付');
    const node = task.nodes[0];
    const [first] = await t.user.nodeRuns(taskId, node.id);
    dropWorkspace(first.id);
    await t.user.revise(taskId, { request: '加一句结尾', nodeIds: [node.id] });
    await t.user.waitTask(taskId, (x) => x.revision?.stage === 'confirm', '修改方案待确认');
    await t.user.decide(taskId, 'continue');
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '第二版交付',
    );
    const runs = await t.user.nodeRuns(taskId, node.id);
    t.log(
      `运行：${runs.map((r) => `${r.purpose}/${r.status}${r.continued ? '(接着)' : ''}`).join(' → ')}`,
    );
    t.check(
      runs.some((r) => r.continued && r.status === 'failed' && /工作目录/.test(r.error ?? '')),
      '接不上原会话的那次运行应记成失败、写明原因',
    );
    t.check(runs.at(-1)?.status === 'succeeded' && !runs.at(-1)?.continued, '应重新开会话做成功');
    t.check(!task.nodes[0].warning, `不应留下提醒：${task.nodes[0].warning}`);
    t.check(
      !t.provider.of('workspace', 'note').some((c) => c.segment === 'revision'),
      '工作目录没了还在接着原会话改',
    );
    const text = await t.user.waitContent(taskId, '笔记.md', (x) => x.includes('结尾'));
    t.check(
      text.includes('第一版') && text.includes('结尾：新会话补上的'),
      `笔记应在上一版的基础上重新做：${text}`,
    );
  },
};

// ---------- 5. 长任务工具：生视频要等十几秒，交出能完整解码的 MP4 ----------
const WAIT = /oasis-tool wait (\S+)/;
const video = {
  title: '落叶短片',
  deliverables: [{ name: '短片', form: 'MP4' }],
  criteria: ['交出能播放的短片'],
  quoteTools: [{ key: 'video.generate', uses: { economy: 5, standard: 5, premium: 10 } }],
  get request() {
    return `生成一段 5 秒的落叶短片 ${marker('video')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('video', 'clip', '生成短片', '用 video.generate 生成 5 秒短片，交出 out/片段.mp4', {
        model: pick(DEFAULT_MODEL),
        tools: [{ key: 'video.generate', uses: 5 }],
        expects: ['片段.mp4'],
        deliver: ['片段.mp4'],
      }),
    ],
    edges: [],
    deliverables: { 短片: 'clip' },
  }),
  nodes: {
    clip: {
      work: [
        {
          bash: 'mkdir -p out && oasis-tool video.generate --prompt "落叶飘下" --duration 5 --out out/片段.mp4; ls out',
          description: '生成视频',
        },
        // 工具没等到就会提示 oasis-tool wait <任务号>：照着等
        ({ last }) =>
          WAIT.test(last ?? '')
            ? { bash: `oasis-tool wait ${WAIT.exec(last)[1]} && ls out`, description: '等视频' }
            : { bash: 'ls -la out', description: '看一眼' },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '短片交付');
    t.check(!task.nodes[0].warning, `短片节点不应有提醒：${task.nodes[0].warning}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.submit'),
      '没有向供应商提交视频任务',
    );
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.content'),
      '没有下载生成好的视频',
    );
    // 关卡的解码检查在 inspector 的检查容器里做，算力按实际用时结算在这个任务上（ADR 0024）
    const decoded = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'compute' and model = 'media-check'`,
    );
    t.check(
      decoded.length > 0 && decoded.every((c) => c.status === 'succeeded'),
      `解码检查的算力应结算在任务上（${decoded.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['片段.mp4']);
    const clip = artifacts.find((a) => a.path === '片段.mp4');
    t.check(clip, '画布里没有短片');
    if (clip)
      t.check(
        sha256(await t.user.content(clip.id)) === sha256(t.fixtures.mp4),
        '画布里的短片和供应商给的不一致',
      );
  },
};

// ---------- 6. 回答不完整：流断在半路、输出被截断，都不能当成做完了 ----------
const BOTH = writeFiles({ 'out/甲.md': '甲\n', 'out/乙.md': '乙\n' });
const fault = {
  title: '两段文字',
  deliverables: [{ name: '两段文字', form: 'Markdown' }],
  criteria: ['甲乙两段都交付'],
  get request() {
    return `写甲乙两段文字 ${marker('fault')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('fault', 'fragile', '写两段', '写甲乙两段，交出 out/甲.md 和 out/乙.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['甲.md', '乙.md'],
        deliver: ['*.md'],
      }),
    ],
    edges: [],
    deliverables: { 两段文字: 'fragile' },
  }),
  nodes: {
    fragile: {
      work: [
        { fault: 'disconnect', bash: writeFiles({ 'out/甲.md': '甲\n' }), description: '写甲' },
        { fault: 'length', bash: writeFiles({ 'out/乙.md': '乙\n' }), description: '写乙' },
      ],
      // 运行失败后平台接着原会话重试：两段都补齐
      resume: [{ bash: BOTH, description: '补齐' }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '两段交付');
    const faults = t.provider.of('fault', 'fragile').filter((c) => c.action.startsWith('fault:'));
    t.check(
      faults.length === 2,
      `两次故障都应发生，实际 ${faults.map((c) => c.action).join('、')}`,
    );
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.log(
      `运行：${runs.map((r) => `${r.purpose}/${r.status}${r.continued ? '(接着)' : ''}`).join(' → ')}`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['甲.md', '乙.md']);
    t.check(
      ['甲.md', '乙.md'].every((p) => artifacts.some((a) => a.path === p)),
      `两段都应交付，画布里有：${artifacts.map((a) => a.path).join('、')}`,
    );
    // 11-08 的 $5.05：流断了拿不到用量时，先凭生成 ID 向供应商查实际花费，查不到才估
    const chats = query(
      'model_gateway',
      `select id, status, cost_source, charged_micro, error from calls where task_id = ${literal(taskId)} and kind = 'chat'`,
    );
    const estimated = chats.filter((c) => c.cost_source === 'estimate');
    t.check(
      estimated.length === 0,
      `流断掉的调用不应按字数估价（${estimated.map((c) => `${c.id.slice(0, 8)} ${c.status} ${c.error ?? ''}`).join('、')}）`,
    );
  },
};

// ---------- 7. harness 重启接管：节点跑命令时 harness 崩了，重启后接着原会话做完 ----------
const takeover = {
  serial: true,
  title: '接管测试报告',
  deliverables: [{ name: '报告', form: 'Markdown' }],
  criteria: ['交出报告'],
  get request() {
    return `写一份报告（中途服务会重启）${marker('takeover')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('takeover', 'long', '写报告', '写报告，交出 out/报告.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['报告.md'],
        deliver: ['报告.md'],
      }),
    ],
    edges: [],
    deliverables: { 报告: 'long' },
  }),
  nodes: {
    long: {
      // 第一步跑到一半 harness 重启：持续目标在原会话里续跑，dsh 告诉模型这条命令丢了（unknown job），重做这一步再往下
      work: [
        {
          bash: 'mkdir -p out && echo 一 > out/一.txt && sleep 30 && echo 二 > out/二.txt',
          description: '慢慢做',
        },
        {
          bash: `test -f out/二.txt && ${writeFiles({ 'out/报告.md': '# 报告\n服务重启后接着做完。\n' })}`,
          description: '写报告',
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'takeover' && c.action === 'bash:0',
      '节点开始跑命令',
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    t.log('重启 harness');
    await t.stack.restart('harness');
    const task = await t.user.waitTask(taskId, done, '接管后交付');
    t.check(!task.nodes[0].warning, `接管后不应留下提醒：${task.nodes[0].warning}`);
    const runs = await t.user.nodeRuns(taskId, task.nodes[0].id);
    t.check(runs.length === 1, `接管应在原来那次运行里接着做，实际 ${runs.length} 次运行`);
    const calls = t.provider.of('takeover', 'long');
    t.check(
      calls.every((c) => c.segments === 1),
      '接管后应在同一个会话里续跑',
    );
    t.check(
      calls.filter((c) => c.action === 'bash:0').length === 2,
      '接管后被打断的那条命令应重做一次',
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 8. model-gateway 重启：模型回答到一半网关崩了，任务照样做完，卡住的调用最后收尾、退回冻结 ----------
const gateway = {
  serial: true,
  title: '网关重启测试',
  deliverables: [{ name: '两段文字', form: 'Markdown' }],
  criteria: ['两段都交付'],
  get request() {
    return `写两段文字（中途网关会重启）${marker('gateway')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('gateway', 'steady', '写两段', '写两段，交出 out/一.md 和 out/二.md', {
        model: pick(DEFAULT_MODEL),
        expects: ['一.md', '二.md'],
        deliver: ['*.md'],
      }),
    ],
    edges: [],
    deliverables: { 两段文字: 'steady' },
  }),
  nodes: {
    steady: {
      work: [
        { bash: writeFiles({ 'out/一.md': '一\n' }), description: '写一' },
        // 第二步的回答挂起：网关就在这时候被重启
        { hang: true, bash: writeFiles({ 'out/二.md': '二\n' }), description: '写二' },
      ],
      resume: [{ bash: writeFiles({ 'out/二.md': '二\n' }), description: '补上二' }],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.provider.waitFor(
      (c) => c.scenario === 'gateway' && c.action === 'hang',
      '模型回答挂起',
    );
    t.log('重启 model-gateway');
    await t.stack.restart('model-gateway');
    await t.user.waitTask(taskId, done, '网关重启后交付');
    const artifacts = await t.user.waitArtifacts(taskId, ['一.md', '二.md']);
    t.check(
      artifacts.some((a) => a.path === '二.md'),
      '画布里没有第二段',
    );
    // 网关崩溃时在途的那次调用没收尾：「快进」半小时后重启网关，启动时的收尾要把它记成失败、退回冻结
    const stuck = query(
      'model_gateway',
      `select id, hold_id from calls where task_id = ${literal(taskId)} and status = 'running'`,
    );
    t.check(stuck.length >= 1, '网关崩溃时在途的调用应留下一条没收尾的记录');
    execute(
      'model_gateway',
      `update calls set created_at = created_at - interval '31 minutes' where task_id = ${literal(taskId)} and status = 'running'`,
    );
    await t.stack.restart('model-gateway');
    let left = stuck;
    for (let i = 0; i < 30 && left.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      left = query(
        'model_gateway',
        `select id from calls where task_id = ${literal(taskId)} and status = 'running'`,
      );
    }
    t.check(left.length === 0, `重启后的收尾没有处理卡住的调用（还剩 ${left.length} 条）`);
    const holds = stuck.filter((c) => c.hold_id).map((c) => literal(c.hold_id));
    if (holds.length) {
      const open = query(
        'billing',
        `select id from holds where id in (${holds.join(',')}) and status = 'open'`,
      );
      t.check(open.length === 0, `卡住的调用的冻结没有退回（${open.length} 笔）`);
    }
  },
};

// ---------- 12. 工具节点：不用 AI，按步骤生成两段视频、再在沙箱里拼成片（ADR 0025） ----------
const SHOTS = ['工具节点镜头一：秋叶', '工具节点镜头二：树梢'];
const STEPS = [
  { tool: 'video.generate', args: { prompt: SHOTS[0], duration: 5 }, out: 'out/镜头/1.mp4' },
  { tool: 'video.generate', args: { prompt: SHOTS[1], duration: 5 }, out: 'out/镜头/2.mp4' },
  {
    tool: 'op.video.concat',
    args: { in: ['out/镜头/1.mp4', 'out/镜头/2.mp4'] },
    out: 'out/成片.mp4',
  },
];
const toolnode = {
  title: '两段拼成片',
  deliverables: [{ name: '成片', form: 'MP4' }],
  criteria: ['两段镜头拼成一段能播放的成片'],
  quoteTools: [{ key: 'video.generate', uses: { economy: 10, standard: 10, premium: 10 } }],
  get request() {
    return `生成两段 5 秒镜头，再拼成成片 ${marker('toolnode')}`;
  },
  plan: () => ({
    nodes: [
      {
        key: 'cut',
        title: '出片',
        kind: 'tool',
        role: '',
        goal: `${marker('toolnode', 'cut')} 生成两段镜头，拼成 out/成片.mp4`,
        steps: STEPS,
        checks: [],
        expects: ['成片.mp4'],
        deliver: ['成片.mp4'],
      },
    ],
    edges: [],
    deliverables: { 成片: 'cut' },
  }),
  nodes: {},
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '成片交付');
    const node = task.nodes[0];
    t.check(
      node?.kind === 'tool' && node.steps?.length === 3,
      `应是 3 步的工具节点：${node?.kind}`,
    );
    t.check(!node?.warning, `工具节点不应有提醒：${node?.warning}`);
    // 估价按目录：两段 × 5 秒 × 每秒 $0.05，加一次算力
    t.check(task.estimateMicro >= 500_000, `估价应含两段视频的钱：${task.estimateMicro}`);
    // 不起 AI：这个节点没有任何模型调用；视频提交了两次
    const asked = t.provider.calls.filter((c) => c.scenario === 'toolnode' && c.kind === 'node');
    t.check(asked.length === 0, `工具节点不应调用模型（调用了 ${asked.length} 次）`);
    // 别的场景可能同时在生视频：按提示词认
    const submitted = t.provider.calls.filter(
      (c) => c.kind === 'video.submit' && SHOTS.includes(c.prompt),
    );
    t.check(submitted.length === 2, `应提交两段视频（提交了 ${submitted.length} 次）`);
    // harness 里这次是工具运行
    const runs = query(
      'harness',
      `select model, status from runs where task_id = ${literal(taskId)} and node_id is not null`,
    );
    t.check(
      runs.length === 1 && runs[0].model === 'oasis/tool' && runs[0].status === 'succeeded',
      `节点应有一次成功的工具运行：${JSON.stringify(runs)}`,
    );
    // 过程：三步各一条命令，拼接由 oasis-op 做
    const { events } = await t.user.api.get(
      `/task/v1/tasks/${taskId}/nodes/${node.id}/events?after=-1`,
    );
    const commands = events
      .filter((e) => e.kind === 'tool_call')
      .map((e) => JSON.parse(e.data.arguments).command);
    t.check(
      commands.length === 3 && commands[2].startsWith('oasis-op video.concat'),
      `过程里应有三步命令、最后一步是 oasis-op：${commands.join(' | ')}`,
    );
    // 关卡照常做解码检查（inspector），算力结算在任务上
    const decoded = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'compute' and model = 'media-check'`,
    );
    t.check(
      decoded.length > 0 && decoded.every((c) => c.status === 'succeeded'),
      `成片的解码检查应结算在任务上（${decoded.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['成片.mp4']);
    const film = artifacts.find((a) => a.path === '成片.mp4');
    t.check(film, '画布里没有成片');
    // 镜头和进度文件只在节点之间传，不交付
    t.check(
      !artifacts.some((a) => a.path.startsWith('.oasis-steps') || a.path.startsWith('镜头/')),
      `只交付成片：${artifacts.map((a) => a.path).join('、')}`,
    );
    if (film) {
      const bytes = await t.user.content(film.id);
      t.check(
        bytes.length > 0 && sha256(bytes) !== sha256(t.fixtures.mp4),
        '成片应是拼接后重新编码的，不是供应商给的原片',
      );
    }
  },
};

export const SCENARIOS = {
  web,
  testplan,
  manifest,
  media,
  revise,
  stop,
  workspace,
  video,
  fault,
  takeover,
  gateway,
  toolnode,
};
