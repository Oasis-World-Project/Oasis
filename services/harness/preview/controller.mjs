/* global process, URL, fetch, setTimeout, clearTimeout, setInterval, Buffer */
// page.evaluate / addInitScript 里的函数在浏览器里执行：
/* global document, getComputedStyle, innerWidth, innerHeight, requestAnimationFrame, MutationObserver */
// 预览容器内唯一的受信控制端。应用和浏览器只访问本容器的回环地址。
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright-core';

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
  const rl = readline.createInterface({ input: process.stdin });
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
  let audioSeq = 0;
  let audioBudget = 8;
  let audioBudgetAt = Date.now();
  await context.exposeBinding('__oasisAudio', (_source, webmBase64) => {
    const now = Date.now();
    audioBudget = Math.min(8, audioBudget + (now - audioBudgetAt) * 0.008);
    audioBudgetAt = now;
    if (typeof webmBase64 === 'string' && webmBase64.length <= 128 * 1024 && audioBudget >= 1) {
      audioBudget -= 1;
      send({ kind: 'audio', seq: audioSeq++, webmBase64 });
    }
  });
  // 页面安定判断用：累计 DOM 变化次数（只计数，不读页面内容）
  await context.addInitScript(() => {
    globalThis.__oasisMutations = 0;
    new MutationObserver((records) => {
      globalThis.__oasisMutations += records.length;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await context.addInitScript(() => {
    const NativeContext = globalThis.AudioContext;
    const NativeMediaRecorder = globalThis.MediaRecorder;
    if (
      !NativeContext ||
      !NativeMediaRecorder ||
      !NativeMediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    )
      return;
    const captures = new WeakMap();
    const originalConnect = globalThis.AudioNode.prototype.connect;
    globalThis.AudioNode.prototype.connect = function (target, ...args) {
      if (target === this.context.destination) {
        const capture = captures.get(this.context);
        if (capture) originalConnect.call(this, capture, args[0] ?? 0, 0);
      }
      return originalConnect.call(this, target, ...args);
    };
    const install = (context) => {
      const destination = context.createMediaStreamDestination();
      captures.set(context, destination);
      const recorder = new NativeMediaRecorder(destination.stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      recorder.ondataavailable = async (event) => {
        if (!event.data.size) return;
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        void globalThis.__oasisAudio(globalThis.btoa(binary));
      };
      recorder.start(250);
    };
    globalThis.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        install(this);
      }
    };
    const originalPlay = globalThis.HTMLMediaElement.prototype.play;
    const mediaSources = new WeakSet();
    globalThis.HTMLMediaElement.prototype.play = function (...args) {
      if (!mediaSources.has(this)) {
        try {
          const context = new globalThis.AudioContext();
          const source = context.createMediaElementSource(this);
          source.connect(context.destination);
          void context.resume();
          mediaSources.add(this);
        } catch {
          /* 元素可能已由应用接入其它音频图 */
        }
      }
      return originalPlay.apply(this, args);
    };
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
  let pendingInput = Promise.resolve();
  let testing = false;

  // 判断以「页面安定下来」为准，不按秒数：慢机器上帧慢，等的时间自然更长。
  // 页面加载完成后，连续这么多个动画帧里条件都不满足、DOM 也没有任何变化，才下「未通过」的结论。
  const SETTLED_FRAMES = 30;
  /** 等下一帧，并返回期间 DOM 是否有变化（变化计数由初始化脚本累计） */
  const nextFrame = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => resolve(globalThis.__oasisMutations ?? 0)),
        ),
    );
  /**
   * 反复检查 probe()，直到它返回 { ok: true }；页面加载完成且连续 SETTLED_FRAMES 帧
   * 结果不变、DOM 不动时，返回最后一次的 { ok: false, why }。
   */
  async function settle(probe) {
    await page.waitForLoadState('load');
    let quiet = 0;
    let mutations = await nextFrame();
    for (;;) {
      const result = await probe();
      if (result.ok) return result;
      const now = await nextFrame();
      quiet = now === mutations ? quiet + 1 : 0;
      mutations = now;
      if (quiet >= SETTLED_FRAMES) return result;
    }
  }
  /** 说清楚一个选择器现在匹配到了什么：几个、第一个的尺寸和样式、文字 */
  async function describe(selector) {
    return page.evaluate((query) => {
      let nodes;
      try {
        nodes = [...document.querySelectorAll(query)];
      } catch {
        return { count: 0, invalid: true };
      }
      const first = nodes[0];
      if (!first) return { count: 0 };
      const box = first.getBoundingClientRect();
      const style = getComputedStyle(first);
      return {
        count: nodes.length,
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
        left: Math.round(box.left),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        disabled: Boolean(first.disabled),
        text: (first.textContent ?? '').trim().slice(0, 200),
      };
    }, selector);
  }
  const shape = (d) =>
    d.invalid
      ? '选择器写法不被浏览器接受'
      : d.count === 0
        ? '页面上没有匹配的元素'
        : `匹配 ${d.count} 个；第一个 ${d.width}×${d.height}px，位置 (${d.left}, ${d.top})，display=${d.display}，visibility=${d.visibility}，opacity=${d.opacity}${d.disabled ? '，已禁用' : ''}${d.text ? `，文字「${d.text}」` : ''}`;
  /** 元素中心点上实际接收点击的是谁（被遮挡时说出挡住它的元素） */
  async function hitTarget(selector) {
    return page.evaluate((query) => {
      const target = document.querySelector(query);
      if (!target) return { ok: false, why: '页面上没有匹配的元素' };
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return { ok: false, why: '元素尺寸为 0' };
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
        return {
          ok: false,
          why: `元素中心 (${Math.round(x)}, ${Math.round(y)}) 在 ${innerWidth}×${innerHeight} 的窗口外`,
        };
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === target || target.contains(hit))) return { ok: true };
      const name = (el) =>
        el
          ? `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? ` data-testid="${el.getAttribute('data-testid')}"` : ''}${typeof el.className === 'string' && el.className ? ` class="${el.className.slice(0, 80)}"` : ''}>`
          : '空白';
      return { ok: false, why: `中心点被 ${name(hit)} 挡住` };
    }, selector);
  }
  /** 浏览器原始报错只取有用的部分：去掉颜色码和 Playwright 的调用日志 */
  const reasonOf = (error) =>
    (error instanceof Error ? error.message : String(error))
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\nCall log:')[0]
      .trim();

  async function test(plan) {
    const report = {
      version: 1,
      target: kind === 'website' ? 'website' : 'application',
      passed: true,
      steps: [],
      diagnostics: [],
      unchecked: [],
    };
    for (const [index, step] of plan.steps.entries()) {
      const result = { index, action: step.action, status: 'passed' };
      report.steps.push(result);
      if (!report.passed) {
        result.status = 'unchecked';
        continue;
      }
      const label = `第 ${index + 1} 步 ${step.action}${step.selector ? ` ${step.selector}` : step.path ? ` ${step.path}` : ''}`;
      try {
        const locator = step.selector ? page.locator(step.selector).first() : undefined;
        /** 等元素可见；要操作它时还要等它可用 */
        const ready = async (usable = true) => {
          const checked = await settle(async () => {
            const d = await describe(step.selector);
            // Playwright 专有写法（如 text=）浏览器认不出，按 Playwright 的可见/可用判断
            if (d.invalid)
              return (await locator.isVisible()) && (!usable || (await locator.isEnabled()))
                ? { ok: true }
                : { ok: false, why: '等到页面安定后仍不可见或不可用' };
            if (!(d.count > 0 && d.width > 0 && d.height > 0 && d.visibility !== 'hidden'))
              return { ok: false, why: `等到页面安定后仍不可见：${shape(d)}` };
            if (usable && d.disabled)
              return { ok: false, why: `等到页面安定后仍是禁用状态：${shape(d)}` };
            return { ok: true };
          });
          if (!checked.ok) throw new Error(checked.why);
        };
        switch (step.action) {
          case 'navigate': {
            const url = new URL(step.path, origin);
            if (url.origin !== origin) throw new Error('导航超出测试目标');
            const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
            if (!response) throw new Error('页面没有响应');
            if (response.status() >= 400) throw new Error(`页面返回 ${response.status()}`);
            break;
          }
          case 'click': {
            await ready();
            if (!(await describe(step.selector)).invalid) {
              const hit = await settle(() => hitTarget(step.selector));
              if (!hit.ok) throw new Error(`等到页面安定后仍点不到：${hit.why}`);
            }
            await locator.click();
            break;
          }
          case 'fill':
            await ready();
            await locator.fill(step.text);
            break;
          case 'press':
            await ready();
            await locator.press(step.key);
            break;
          case 'visible':
            await ready(false);
            break;
          case 'text':
          case 'count': {
            const checked = await settle(async () => {
              if (step.action === 'count') {
                const count = await page.locator(step.selector).count();
                return count === step.count
                  ? { ok: true }
                  : { ok: false, why: `等到页面安定后匹配 ${count} 个，要求 ${step.count} 个` };
              }
              const texts = await page.locator(step.selector).allTextContents();
              return texts.some((text) => text.includes(step.text))
                ? { ok: true }
                : {
                    ok: false,
                    why: texts.length
                      ? `等到页面安定后文字不含「${step.text}」，实际为「${texts.join(' | ').slice(0, 300)}」`
                      : '页面上没有匹配的元素',
                  };
            });
            if (!checked.ok) throw new Error(checked.why);
            break;
          }
          case 'screenshot':
            break;
          default:
            throw new Error('不支持的测试步骤');
        }
      } catch (error) {
        result.status = 'failed';
        result.error = `${label}：${reasonOf(error)}`;
        report.passed = false;
      }
      if (step.action === 'screenshot' || result.status === 'failed') {
        try {
          const bytes = await page.screenshot({ type: 'jpeg', quality: 45 });
          result.screenshot = `step-${index}.jpg`;
          send({
            kind: 'test-screenshot',
            name: result.screenshot,
            base64: bytes.toString('base64'),
          });
        } catch (error) {
          report.unchecked.push(`第 ${index + 1} 步截图未取得：${reasonOf(error)}`);
        }
      }
    }
    if (!plan.steps.some((step) => ['visible', 'text', 'count'].includes(step.action)))
      report.unchecked.push('没有业务断言，仅验证操作可执行');
    send({ kind: 'test-result', report });
  }
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
        .then(() => test(input.plan))
        .catch((error) => {
          send({ kind: 'error', message: `浏览器测试中断：${reasonOf(error)}` });
        })
        .finally(() => {
          testing = false;
        });
      return;
    }
    if (testing) return;
    if (
      input.kind === 'pointer' &&
      Number.isInteger(input.x) &&
      Number.isInteger(input.y) &&
      input.x >= 0 &&
      input.x < 1280 &&
      input.y >= 0 &&
      input.y < 720
    ) {
      pendingInput = pendingInput
        .then(async () => {
          await page.mouse.move(input.x, input.y);
          if (input.action === 'down') await page.mouse.down();
          if (input.action === 'up') await page.mouse.up();
        })
        .catch(() => undefined);
    } else if (input.kind === 'key' && typeof input.key === 'string' && input.key.length <= 32) {
      pendingInput = pendingInput
        .then(async () => {
          if (input.action === 'down') await page.keyboard.down(input.key);
          if (input.action === 'up') await page.keyboard.up(input.key);
        })
        .catch(() => undefined);
    } else if (
      input.kind === 'scroll' &&
      Number.isInteger(input.deltaY) &&
      Math.abs(input.deltaY) <= 1000
    ) {
      pendingInput = pendingInput
        .then(() => page.mouse.wheel(0, input.deltaY))
        .catch(() => undefined);
    }
  });
  let seq = 0;
  send({ kind: 'ready' });
  setInterval(() => {
    if (drawing || testing) return;
    drawing = true;
    void page
      .screenshot({ type: 'jpeg', quality: 65 })
      .then((bytes) => send({ kind: 'frame', seq: seq++, jpegBase64: bytes.toString('base64') }))
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
