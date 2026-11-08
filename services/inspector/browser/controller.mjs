/* global process, URL, fetch, setTimeout, clearTimeout, setInterval, Buffer */
// addInitScript 里的函数在浏览器里执行：
/* global document, MutationObserver */
// 检查浏览器容器里唯一的受信控制端（ADR 0024）：起应用、开浏览器，按 inspector 经 stdin 发来的指令检查，
// 结果经 stdout 一行一个 JSON 送回。应用和浏览器只访问本容器的回环地址；外站测试的请求转给 inspector 代取。
// inspector 断开（检查结束、被停止、inspector 意外退出）时 stdin 关闭，控制端随即退出、容器被自动删除。
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright-core';
import { createChecks, reasonOf } from './checks.mjs';

const root = '/workspace/app';
const kind = process.env.APP_KIND;
const entry = process.env.APP_ENTRY;
const port = Number(process.env.APP_PORT);
const origin =
  kind === 'website' ? new URL(process.env.WEBSITE_URL).origin : `http://127.0.0.1:${port}`;
const staticRoot = kind === 'static' ? path.resolve(root, path.dirname(entry ?? '')) : root;
const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);

if (
  !['static', 'node', 'website'].includes(kind) ||
  !/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(entry ?? '') ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
) {
  send({ kind: 'error', message: '应用启动配置不合法' });
  process.exit(1);
}

// 一开始就盯着 stdin：inspector 断开就退出，不留下没人管的浏览器
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));

function filePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return undefined;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((part) => part === '.' || part === '..')) return undefined;
  const absolute = path.resolve(staticRoot, ...segments);
  return absolute === staticRoot || absolute.startsWith(`${staticRoot}${path.sep}`)
    ? absolute
    : undefined;
}

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

let server;
let child;
if (kind === 'static') {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    let target = filePath(url.pathname);
    if (!target) {
      res.writeHead(400).end();
      return;
    }
    if (existsSync(target) && statSync(target).isDirectory())
      target = target === staticRoot ? path.join(root, entry) : path.join(target, 'index.html');
    if (!existsSync(target) && !path.extname(target)) target = path.join(root, entry);
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      'content-type',
      `${mime[path.extname(target)] ?? 'application/octet-stream'}${['.html', '.js', '.mjs', '.css', '.json', '.svg'].includes(path.extname(target)) ? '; charset=utf-8' : ''}`,
    );
    res.setHeader('cache-control', 'no-store');
    createReadStream(target).pipe(res);
  });
  await new Promise((resolve, reject) =>
    server.listen(port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
  );
} else if (kind === 'node') {
  child = spawn(process.execPath, [path.join(root, entry)], {
    cwd: root,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  });
  // 不把应用写到 stdout 的任意文本当成控制协议，也不转发可能含私有数据的日志。
  child.stdout.resume();
  child.stderr.resume();
}

/** 等应用在回环地址上应答：不设次数或时长，进程退出才算启动失败（用户停止会回收整个容器） */
async function reachable() {
  for (;;) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`应用没有在回环地址启动：进程已退出（退出码 ${child.exitCode}）`);
    try {
      const response = await fetch(origin);
      if (response.status < 500) return;
    } catch {
      /* 等启动 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

let browser;
let drawing = false;
try {
  if (kind !== 'website') await reachable();
  const requests = new Map();
  let requestSeq = 0;
  rl.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      if (value.kind === 'fetch-result') requests.get(value.id)?.(value);
    } catch {
      /* 非控制消息忽略 */
    }
  });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: [],
    serviceWorkers: 'block',
  });
  // 页面安定判断用：累计 DOM 变化次数（只计数，不读页面内容）
  await context.addInitScript(() => {
    globalThis.__oasisMutations = 0;
    new MutationObserver((records) => {
      globalThis.__oasisMutations += records.length;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await context.route('**/*', async (route) => {
    try {
      if (kind === 'website') {
        const id = requestSeq++;
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            requests.delete(id);
            reject(new Error('出口超时'));
          }, 10000);
          requests.set(id, (value) => {
            clearTimeout(timer);
            requests.delete(id);
            resolve(value);
          });
          send({ kind: 'fetch', id, url: route.request().url(), method: route.request().method() });
        });
        if (result.error) await route.abort('blockedbyclient');
        else
          await route.fulfill({
            status: result.status,
            headers: result.headers,
            body: Buffer.from(result.body, 'base64'),
          });
        return;
      }
      const u = new URL(route.request().url());
      if (u.origin === origin) await route.continue();
      else await route.abort('blockedbyclient');
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (error) =>
    send({ kind: 'diagnostic', message: `页面错误：${error.message.slice(0, 300)}` }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      send({ kind: 'diagnostic', message: `控制台错误：${message.text().slice(0, 300)}` });
  });
  page.on('requestfailed', (request) =>
    send({ kind: 'diagnostic', message: `请求失败：${request.url().slice(0, 200)}` }),
  );
  // 不设时限：页面多慢都等它加载，用户停止时整个容器被回收
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
  const firstPage = await page.goto(kind === 'website' ? process.env.WEBSITE_URL : origin, {
    waitUntil: 'domcontentloaded',
  });
  if (!firstPage || firstPage.status() >= 400)
    throw new Error(`首页返回 ${firstPage?.status() ?? '空响应'}`);
  /**
   * 静态网页（ADR 0021）：inspector 把入口换成了只放隔离框的外壳，框里是和画布一模一样的文档。
   * 测试步骤、安定判断都对着框里的页面做；其他种类直接对着整页。
   */
  const liveFrame = async () => {
    // 外壳是 inspector 生成的，框就写在首页文档里：首页加载完还没有，就是没套上外壳，不再干等
    const handle = await page.$('iframe[title="oasis-live"]');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('隔离框没有打开');
    return frame;
  };
  const checks = createChecks({
    page,
    context,
    kind,
    entry,
    origin,
    send,
    target: kind === 'static' ? await liveFrame() : page,
    liveFrame,
  });
  let pendingInput = Promise.resolve();
  let testing = false;
  rl.on('line', (line) => {
    let input;
    try {
      input = JSON.parse(line);
    } catch {
      return;
    }
    if (input.kind === 'test' && !testing && Array.isArray(input.plan?.steps)) {
      testing = true;
      pendingInput = pendingInput
        .then(() => checks.test(input.plan))
        .catch((error) => {
          send({ kind: 'error', message: `浏览器测试中断：${reasonOf(error)}` });
        })
        .finally(() => {
          testing = false;
        });
      return;
    }
    if (input.kind === 'look' && !testing) {
      testing = true;
      pendingInput = pendingInput
        .then(async () => send({ kind: 'look-result', ...(await checks.look()) }))
        .catch((error) => {
          send({ kind: 'error', message: `画面检查中断：${reasonOf(error)}` });
        })
        .finally(() => {
          testing = false;
        });
    }
  });
  let seq = 0;
  send({ kind: 'ready' });
  setInterval(() => {
    if (drawing || testing) return;
    drawing = true;
    void page
      .screenshot({ type: 'jpeg', quality: 65 })
      .then((bytes) =>
        send({ kind: 'frame', seq: seq++, jpegBase64: Buffer.from(bytes).toString('base64') }),
      )
      .catch(() => undefined)
      .finally(() => {
        drawing = false;
      });
  }, 250);
} catch (err) {
  send({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  await browser?.close().catch(() => undefined);
  child?.kill();
  server?.close();
  process.exitCode = 1;
}
