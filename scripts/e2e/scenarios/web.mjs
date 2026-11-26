// 回归场景（docs/engineering/回归测试.md）：聊天（再关掉联网搜索说一句）；做网页（交之前自查，发现问题自己修）；
// 一个 AI 用各种工具从头做到交付。
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { aiOf, cardOf, runsOf, sha256, start } from './shared.mjs';

// ---------- 1. 聊天：说「你好」，AI 回一句话；只聊天不出任务卡。再关掉联网搜索说一句：
// 给 AI 的说明里写着关了，工具目录里没有联网的两个工具，硬要搜索被拒绝、不花钱 ----------
export const chat = {
  says: {
    1: { reply: '你好！想做点什么？' },
    2: {
      steps: [
        {
          bash: 'grep -c 联网搜索现在关着 ~/.dsh/AGENTS.md; oasis-tool list | grep -c "web\\." ; true',
          description: '看说明和工具目录',
        },
        { bash: 'oasis-tool web.search --query 今天的新闻 2>&1; true', description: '硬要搜索' },
        ({ done }) => ({
          text: `说明里 ${String(done[0]?.result).trim().split('\n')[0]} 处，目录里 ${String(done[0]?.result).trim().split('\n')[1]} 个，搜索：${String(done[1]?.result).slice(0, 200)}`,
        }),
      ],
    },
  },
  async run(t) {
    const id = await start(t, 'chat', '你好');
    const messages = await t.user.waitTurn(id, '回话');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    const ai = aiOf(messages, run?.id);
    t.check(
      ai.length === 1 && ai[0].status === 'complete' && ai[0].content.includes('想做点什么'),
      `AI 应回一句话：${JSON.stringify(ai.map((m) => [m.status, m.content]))}`,
    );
    t.check(!messages.some((m) => m.kind === 'task'), '只聊天不应出任务卡');
    t.check(
      (ai[0]?.data.spentMicro ?? 0) > 0,
      `这一轮的花费应写在 AI 的话上：${ai[0]?.data.spentMicro}`,
    );

    // ---- 关掉联网搜索：不开新话题；下一轮 AI 的说明里写着关了、目录里没有联网工具、硬搜被拒 ----
    const dm = `/conversation/v1/conversations/${id}`;
    const saved = await t.user.api.put(`${dm}/setup`, {
      workplace: { kind: 'cloud' },
      permissions: { mode: 'auto', web: false },
    });
    t.check(
      saved.message === null && saved.conversation.permissions.web === false,
      `关掉联网搜索应记在这段私聊上、不开新话题：${JSON.stringify(saved.conversation.permissions)}`,
    );
    await t.user.say(id, `查一下今天的新闻 ${marker('chat', 2)}`);
    const after = await t.user.waitTurn(id, '关着联网搜索的一轮');
    const second = runsOf(id)[1];
    const told = aiOf(after, second?.id).at(-1)?.content ?? '';
    t.check(
      told.includes('说明里 1 处') && told.includes('目录里 0 个'),
      `关着时说明里应写明、工具目录里不应有联网工具：${told}`,
    );
    t.check(told.includes('用户关了这段对话的联网搜索'), `硬要搜索应被拒绝并说明原因：${told}`);
  },
};

// ---------- 2. 多文件网页：AI 交之前自查（按画布的方式在检查浏览器里点一遍），发现计数错了自己修好；
// 画布里登记成可运行的网页，任务卡上列着成品，桌面端画布里打得开、点得对 ----------
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
  says: {
    1: {
      steps: [
        // 第一版计数每次加 2：自查按 oasis-test.json 点一遍会发现
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
        // 交之前自查：沙箱带着 out/site 的文件经网关交给 inspector，按画布的方式打开、照测试计划点一遍
        { bash: 'oasis-tool app.check --dir out/site', description: '自查网页' },
        ({ last }) =>
          /第 3 步 text/.test(last ?? '')
            ? { bash: writeFiles({ 'out/site/counter.js': counter(1) }), description: '修计数' }
            : { text: `自查没查出计数的问题：${(last ?? '').slice(0, 200)}` },
        { bash: 'oasis-tool app.check --dir out/site', description: '再查一次' },
      ],
      reply: '计数网页做好了，点「加一」就加一。',
    },
  },
  async run(t) {
    const id = await start(t, 'web', '做一个计数小网页，HTML、CSS、JS 分开放');
    const messages = await t.user.waitTurn(id, '网页交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    const calls = t.provider.of('web', 1);
    t.check(
      calls.some((c) => c.action === 'bash:2'),
      `自查发现计数不对后应自己修（${calls.map((c) => c.action).join(' → ')}）`,
    );
    const rechecked = calls.find((c) => c.action === 'done');
    t.check(
      rechecked?.previous?.includes('浏览器检查通过'),
      `修好后再查应通过：${rechecked?.previous ?? '没有记录'}`,
    );
    // 两次自查开的检查浏览器：算力按实际用时结算在这一轮上
    const browsed = query(
      'model_gateway',
      `select status from calls where run_id = ${literal(run?.id)} and kind = 'compute' and model = 'application-check'`,
    );
    t.check(
      browsed.length === 2 && browsed.every((c) => c.status === 'succeeded'),
      `自查的算力应结算在这一轮上（${browsed.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    // AI 的消息里按顺序记着做过的每一步
    const steps = aiOf(messages, run?.id)
      .flatMap((m) => m.data.parts ?? [])
      .filter((p) => p.type === 'step');
    t.check(
      steps.length === 4 && steps.every((s) => s.status === 'done'),
      `AI 的消息里应有做完的 4 步：${steps.map((s) => `${s.label}/${s.status}`).join('、')}`,
    );
    const expected = [
      'site/app.js',
      'site/counter.js',
      'site/index.html',
      'site/oasis-app.json',
      'site/oasis-test.json',
      'site/style.css',
    ];
    const artifacts = await t.user.waitArtifacts(id, expected);
    const paths = artifacts.map((a) => a.path).sort();
    for (const file of expected)
      t.check(paths.includes(file), `画布里缺 ${file}（有：${paths.join('、')}）`);
    // 交了文件的一轮出任务卡，成品列在卡上
    const card = cardOf(messages, run?.id);
    t.check(
      card?.data.status === 'done' &&
        expected.every((p) => card.data.files.some((f) => f.path === p)),
      `任务卡上应列着交的文件：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
    const js = artifacts.find((a) => a.path === 'site/counter.js');
    if (js)
      t.check(
        (await t.user.content(js.id)).toString().includes('STEP = 1'),
        '画布里的 counter.js 不是修好后的版本',
      );
    const app = (await t.user.waitApplication(id)).find((a) => a.application?.kind === 'static');
    t.check(app, '画布里没有可运行的网页成果');
    if (app) await t.canvas(app, PAGE_TEST);
  },
};

// ---------- 3. 一个 AI 从头做到交付：问另一个模型、自己调工具拿素材、做多文件网页、
// 用沙箱里的浏览器自己点一遍、再按画布的方式查一次 ----------
const COVER_PAGE = PAGE.replace(
  '<p>已经点了',
  '<img id="cover" src="cover.png" alt="插图" width="160"><p>已经点了',
);
/** AI 自己写的浏览器脚本：页面的脚本是 ES 模块，要经 http 打开，所以先在回环地址上起一个静态服务 */
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
  says: {
    1: {
      steps: [
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
      reply: '带插图的计数网页做好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'solo', '做一个带插图的计数小网页');
    const messages = await t.user.waitTurn(id, '网页交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'image'),
      'AI 没有自己调生图工具',
    );
    const calls = t.provider.of('solo', 1);
    const asked = calls.find((c) => c.action === 'bash:1');
    t.check(
      asked?.previous?.includes('好的。'),
      `AI 应能问另一个模型并拿到回答：${asked?.previous ?? '没有记录'}`,
    );
    const played = calls.find((c) => c.action === 'bash:4');
    t.check(
      played?.previous?.includes('BROWSER {"count":"2","cover":true,"shot":true}'),
      `AI 应能用沙箱里的浏览器打开自己做的页面、点两下、看到插图并截图：${played?.previous ?? '没有记录'}`,
    );
    const checked = calls.find((c) => c.action === 'done');
    t.check(
      checked?.previous?.includes('浏览器检查通过'),
      `按画布的方式自查应通过：${checked?.previous ?? '没有记录'}`,
    );
    // 用了生图工具：出任务卡，卡上的花费含生图的钱
    const tools = query(
      'model_gateway',
      `select status, charged_micro from calls where run_id = ${literal(run?.id)} and kind = 'tool'`,
    );
    const toolMicro = tools.reduce((sum, c) => sum + Number(c.charged_micro), 0);
    t.check(
      tools.some((c) => c.status === 'succeeded') && toolMicro > 0,
      `生图应记在这一轮上并扣费：${JSON.stringify(tools)}`,
    );
    const card = cardOf(messages, run?.id);
    t.check(
      card?.data.status === 'done' && card.data.spentMicro >= toolMicro,
      `任务卡应记着这一轮的花费（含生图）：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
    const expected = [
      'site/app.js',
      'site/counter.js',
      'site/cover.png',
      'site/index.html',
      'site/oasis-app.json',
      'site/style.css',
    ];
    const artifacts = await t.user.waitArtifacts(id, expected);
    const paths = artifacts.map((a) => a.path).sort();
    for (const file of expected)
      t.check(paths.includes(file), `画布里缺 ${file}（有：${paths.join('、')}）`);
    const cover = artifacts.find((a) => a.path === 'site/cover.png');
    if (cover)
      t.check(
        sha256(await t.user.content(cover.id)) === sha256(t.fixtures.png),
        '画布里的插图和供应商给的图不一致',
      );
    const app = (await t.user.waitApplication(id)).find((a) => a.application?.kind === 'static');
    t.check(app, '画布里没有可运行的网页成果');
    if (app) await t.canvas(app, PAGE_TEST);
  },
};
