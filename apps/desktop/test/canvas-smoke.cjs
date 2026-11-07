// 画布回归（pnpm e2e，docs/engineering/回归测试.md）：用正式的桌面外壳登录、打开一份网页成果，
// 在画布的隔离框里按测试计划操作一遍。检查的是用户真正看到的那份：桌面窗口 + Web 前端 + gateway + 画布成果。
const { app, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  OASIS_WEB_URL: web,
  OASIS_CANVAS_PATH: route,
  OASIS_CANVAS_COOKIE: cookie,
  OASIS_CANVAS_PLAN: planText,
  OASIS_CANVAS_EVIDENCE: evidence,
} = process.env;
// 配置不对时直接退出：加载时抛错 Electron 会弹出错误对话框一直等着
if (!web || !route || !cookie || !planText || !evidence || !path.isAbsolute(evidence)) {
  process.stderr.write('画布回归失败：缺少配置（OASIS_CANVAS_EVIDENCE 要是绝对路径）\n');
  process.exit(1);
}
app.setPath('userData', path.join(evidence, '.profile'));
let window;
// 外壳自己会先打开首页（失败每秒重试）：等首页真正加载完再跳画布，
// 否则两次跳转互相打断，画布这次会以 ERR_ABORTED 失败（2026-11-08 回归里出现过）
let shellLoaded = false;
app.on('browser-window-created', (_event, win) => {
  window = win;
  win.hide();
  win.webContents.once('did-finish-load', () => {
    shellLoaded = true;
  });
});
const deadline = setTimeout(() => {
  process.stderr.write('画布回归超时（120 秒）\n');
  app.exit(1);
}, 120_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 反复执行一段脚本直到返回真值（页面在加载、框还没出来时重试） */
async function until(run, label, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await run();
      if (last) return last;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(`${label}（最后看到：${JSON.stringify(last)}）`);
}

const main = (code) => window.webContents.executeJavaScript(code);
/** 画布里运行网页的隔离框（srcdoc 框） */
const liveFrame = () =>
  window.webContents.mainFrame.framesInSubtree.find(
    (frame) => frame !== window.webContents.mainFrame && frame.url === 'about:srcdoc',
  );
const inFrame = (code) => {
  const frame = liveFrame();
  if (!frame) throw new Error('还没有隔离框');
  return frame.executeJavaScript(code, true);
};
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

async function step(item, index) {
  const label = `第 ${index + 1} 步 ${item.action}${item.selector ? ` ${item.selector}` : ''}`;
  switch (item.action) {
    case 'click':
      await until(() => inFrame(`!!${q(item.selector)}`), `${label}：找不到元素`);
      await inFrame(`${q(item.selector)}.click(), true`);
      return;
    case 'fill':
      await until(() => inFrame(`!!${q(item.selector)}`), `${label}：找不到元素`);
      await inFrame(
        `(() => { const el = ${q(item.selector)}; el.value = ${JSON.stringify(item.text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      );
      return;
    case 'press':
      await inFrame(
        `(() => { const el = ${q(item.selector)}; for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(item.key)}, bubbles: true })); return true; })()`,
      );
      return;
    case 'text':
      await until(
        () =>
          inFrame(
            `(${q(item.selector)}?.textContent ?? '').trim() === ${JSON.stringify(item.text)}`,
          ),
        `${label}：文字不是「${item.text}」`,
        10_000,
      );
      return;
    case 'visible':
      await until(
        () =>
          inFrame(
            `(() => { const r = ${q(item.selector)}?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })()`,
          ),
        `${label}：元素不可见`,
        10_000,
      );
      return;
    case 'count':
      await until(
        () =>
          inFrame(
            `document.querySelectorAll(${JSON.stringify(item.selector)}).length === ${item.count}`,
          ),
        `${label}：数量不是 ${item.count}`,
        10_000,
      );
      return;
    default:
      // screenshot、navigate：画布里的隔离框不跳页，截图由关卡的浏览器检查负责
      return;
  }
}

(async () => {
  await import(pathToFileURL(path.join(__dirname, '../dist/main.js')).href);
  await app.whenReady();
  const [name, ...rest] = cookie.split(';')[0].split('=');
  await session.defaultSession.cookies.set({
    url: web,
    name,
    value: rest.join('='),
    httpOnly: true,
  });
  await until(() => window, '桌面窗口没有出现');
  await until(() => shellLoaded, '桌面外壳没能打开 Web 前端', 60_000);
  await window.loadURL(new URL(route, web).href);
  // 画布页面：不是登录页、成果没报错、隔离框只给脚本权限
  await until(() => liveFrame(), '画布里没有出现网页的隔离框');
  const sandbox = await main(`document.querySelector('iframe[srcdoc]')?.getAttribute('sandbox')`);
  if (sandbox !== 'allow-scripts allow-pointer-lock') throw new Error(`隔离框权限不对：${sandbox}`);
  const opened = await main(`document.body.innerText.includes('网页没能打开')`);
  if (opened) throw new Error('画布显示「网页没能打开」');
  // 样式和脚本都在框里生效（同一成果里的 style.css、app.js 按相对地址内嵌）
  await until(() => inFrame(`document.readyState === 'complete'`), '隔离框里的网页没加载完');
  const plan = JSON.parse(planText);
  for (const [index, item] of plan.steps.entries()) await step(item, index);
  const html = await inFrame('document.documentElement.outerHTML');
  await fs.writeFile(path.join(evidence, 'frame.html'), html);
  process.stdout.write('CANVAS_OK\n');
  clearTimeout(deadline);
  app.exit(0);
})().catch(async (err) => {
  const frames = window?.webContents.mainFrame.framesInSubtree.map((f) => f.url) ?? [];
  const page = await main('location.href + " | " + document.body.innerText.slice(0, 300)').catch(
    () => '',
  );
  process.stderr.write(
    `画布回归失败：${err instanceof Error ? err.message : String(err)}\n页面：${page}\n框：${frames.join(' , ')}\n`,
  );
  app.exit(1);
});
