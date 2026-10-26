/* global process, URL, fetch, AbortSignal, setTimeout, setInterval */
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
const origin = `http://127.0.0.1:${port}`;
const staticRoot = kind === 'static' ? path.resolve(root, path.dirname(entry ?? '')) : root;
const send = (data) => process.stdout.write(`${JSON.stringify(data)}\n`);
if (
  !['static', 'node'].includes(kind) ||
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
    if (existsSync(target) && statSync(target).isDirectory()) target = path.join(root, entry);
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
} else {
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

async function reachable() {
  for (let i = 0; i < 80; i += 1) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) break;
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.status < 500) return;
    } catch {
      /* 等启动 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('应用没有在回环地址按时启动');
}

let browser;
let drawing = false;
try {
  await reachable();
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: [],
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
  const firstPage = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  if (!firstPage || firstPage.status() >= 400)
    throw new Error(`首页返回 ${firstPage?.status() ?? '空响应'}`);
  const rl = readline.createInterface({ input: process.stdin });
  let pendingInput = Promise.resolve();
  rl.on('line', (line) => {
    let input;
    try {
      input = JSON.parse(line);
    } catch {
      return;
    }
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
    if (drawing) return;
    drawing = true;
    void page
      .screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 5000 })
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
