// 在本机起 10 个服务和 Web，代码改了也不跟着重启：回归测试（pnpm e2e）和验收模式（pnpm accept）共用。
// 每个服务直接用 node 跑 src/main.ts（和 pnpm dev 同一份代码、同一份 .env），日志写到文件里；
// 回归测试可以单独杀掉、重启某个服务，模拟崩溃和重启。
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** 启动分两批：模型目录（agent）先起来，假供应商要读它；其余的不分先后 */
export const FIRST = ['identity', 'billing', 'agent'];
export const SECOND = [
  'inspector',
  'model-gateway',
  'harness',
  'canvas',
  'task',
  'conversation',
  'gateway',
];
export const SERVICES = [...FIRST, ...SECOND];
const DEFAULT_PORTS = {
  gateway: 8080,
  identity: 4101,
  billing: 4102,
  agent: 4103,
  conversation: 4104,
  task: 4105,
  canvas: 4106,
  harness: 4107,
  'model-gateway': 4108,
  inspector: 4109,
};

/** 读一个 .env 文件（只取 KEY=VALUE 行） */
export function readEnv(file) {
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

export const portOf = (name) =>
  Number(readEnv(path.join(ROOT, 'services', name, '.env')).PORT ?? DEFAULT_PORTS[name]);

export const webPort = () =>
  Number(readEnv(path.join(ROOT, 'apps', 'web', '.env')).WEB_PORT ?? 5173);

/** 端口是否已被占用（pnpm dev 还开着时） */
export function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INFRA = [
  'postgres',
  'nats',
  'seaweedfs',
  'mailpit',
  'valkey',
  'sandbox-ingress',
  'sandbox-egress',
];
/** 中间件都健康就不动它们（compose up 会重建容器）；否则照 pnpm infra:up 起一遍 */
export function ensureInfra(log = () => {}) {
  const health = spawnSync(
    'docker',
    ['inspect', '-f', '{{.State.Health.Status}}', ...INFRA.map((s) => `oasis-${s}-1`)],
    { encoding: 'utf8', windowsHide: true },
  );
  if (
    health.status === 0 &&
    health.stdout
      .trim()
      .split(/\s+/)
      .every((s) => s === 'healthy')
  )
    return;
  log('启动中间件');
  const up = spawnSync('node scripts/compose.mjs up', {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (up.status !== 0) throw new Error('中间件没起来：node scripts/compose.mjs up 失败');
}

/** 日志最后几行：服务没起来时附在报错里 */
function tail(file, lines = 30) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * @param {{ logDir: string, env?: Record<string, Record<string, string>>, log?: (line: string) => void }} options
 *   env 按服务名给出要覆盖的环境变量（优先于服务自己的 .env）
 */
export function createStack(options) {
  const { logDir } = options;
  const log = options.log ?? (() => {});
  mkdirSync(logDir, { recursive: true });
  /** @type {Map<string, { child: import('node:child_process').ChildProcess, exited: Promise<void>, file: string }>} */
  const procs = new Map();
  const alive = (name) => {
    const child = procs.get(name)?.child;
    return !!child && child.exitCode === null && child.signalCode === null;
  };

  function launch(name, args, cwd, env, file) {
    const out = createWriteStream(file, { flags: 'a' });
    out.write(`\n===== ${new Date().toISOString()} 启动 ${name} =====\n`);
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        out.end(`\n===== 退出 code=${code} signal=${signal} =====\n`);
        resolve();
      });
      child.once('error', (err) => {
        out.end(`\n===== 启动失败 ${err.message} =====\n`);
        resolve();
      });
    });
    procs.set(name, { child, exited, file });
  }

  async function waitUrl(name, url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive(name)) throw new Error(`${name} 启动后退出了：\n${tail(procs.get(name).file)}`);
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok) return;
      } catch {
        // 还没监听，接着等
      }
      await sleep(500);
    }
    throw new Error(`${name} ${timeoutMs / 1000} 秒内没有就绪：\n${tail(procs.get(name).file)}`);
  }

  async function start(name) {
    if (alive(name)) throw new Error(`${name} 已经在运行`);
    const port = portOf(name);
    if (await portBusy(port)) throw new Error(`${name} 的端口 ${port} 被占用（先停掉 pnpm dev）`);
    launch(
      name,
      ['--env-file-if-exists=.env', 'src/main.ts'],
      path.join(ROOT, 'services', name),
      options.env?.[name] ?? {},
      path.join(logDir, `${name}.log`),
    );
    await waitUrl(name, `http://127.0.0.1:${port}/ready`, 180_000);
    log(`${name} 已就绪（:${port}）`);
  }

  /** 直接结束进程（Windows 上就是强行结束），用来模拟崩溃；正常收尾也用它，服务都是无状态的 */
  async function kill(name) {
    if (!alive(name)) return;
    const entry = procs.get(name);
    entry.child.kill('SIGKILL');
    await entry.exited;
    // 等端口真正放出来，否则马上重启会撞上
    const port = name === 'web' ? webPort() : portOf(name);
    for (let i = 0; i < 40 && (await portBusy(port)); i++) await sleep(250);
    log(`${name} 已停止`);
  }

  /** Web（Vite）：验收模式用构建好的版本（vite preview），回归测试用开发服务器 */
  async function startWeb(mode = 'dev') {
    const cwd = path.join(ROOT, 'apps', 'web');
    const vitePackage = createRequire(path.join(cwd, 'package.json')).resolve('vite/package.json');
    const vite = path.join(path.dirname(vitePackage), 'bin', 'vite.js');
    const port = webPort();
    if (await portBusy(port)) throw new Error(`Web 的端口 ${port} 被占用（先停掉 pnpm dev）`);
    launch(
      'web',
      [vite, ...(mode === 'preview' ? ['preview'] : [])],
      cwd,
      options.env?.web ?? {},
      path.join(logDir, 'web.log'),
    );
    await waitUrl('web', `http://127.0.0.1:${port}/`, 120_000);
    log(`Web 已就绪（http://127.0.0.1:${port}）`);
    return `http://127.0.0.1:${port}`;
  }

  return {
    start,
    kill,
    startWeb,
    async restart(name) {
      await kill(name);
      await start(name);
    },
    /** 一批服务一起起 */
    startAll: (names) => Promise.all(names.map(start)),
    async stopAll() {
      await Promise.all([...procs.keys()].map(kill));
    },
    running: alive,
    logFile: (name) => procs.get(name)?.file ?? path.join(logDir, `${name}.log`),
  };
}
