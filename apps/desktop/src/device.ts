// 在你的电脑上干活：桌面版主动连上 Oasis（WebSocket，带登录 Cookie，协议见 @oasis/contracts/device），
// harness 把一轮交给这台电脑：在用户选过的项目文件夹里起 dsh、转发它的输入输出、放进和取回平台的文件。
// 只在用户在这台电脑上选过的文件夹里干活；dsh 的家目录按会话放在桌面版自己的数据目录里（不碰用户的 ~/.dsh）。
// 断开了自动重连；断开时正在跑的 dsh 都结束掉（这一轮在 Oasis 那边停下，说「继续」接着做）。
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DesktopDevice, DesktopProjectFolder } from '@oasis/contracts/desktop';
import { HarnessMessage, type DeviceMessage } from '@oasis/contracts/device';
import { WebSocket } from 'ws';
import {
  extractTar,
  listFiles,
  packPath,
  placePath,
  resolvePlace,
  type Place,
} from './device-files.ts';
import type { DshRuntime } from './dsh-runtime.ts';

/** 一条消息最大多大（harness 一次交来的文件最多 512 MiB，base64 后约 683 MiB） */
const MAX_PAYLOAD = 768 * 1024 * 1024;
/** 多久没收到 harness 的心跳就当断了（它 25 秒一次） */
const SILENT_MS = 70_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** 交给 dsh 的环境变量只认这两类（别的一概不收，比如 NODE_OPTIONS） */
const ENV_PREFIXES = ['OASIS_', 'DSH_'];

interface DeviceState {
  deviceId: string;
  /** 用户在这台电脑上选过的项目文件夹：只在这些里面干活 */
  folders: string[];
}

const sameFolder = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

function loadState(file: string): DeviceState {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeviceState>;
    if (typeof saved.deviceId === 'string' && Array.isArray(saved.folders))
      return {
        deviceId: saved.deviceId,
        folders: saved.folders.filter((f) => typeof f === 'string'),
      };
  } catch {
    // 第一次用：下面新建
  }
  return { deviceId: randomUUID(), folders: [] };
}

/** 结束 dsh 和它起的命令（Windows 上连子进程一起结束） */
function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32')
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
}

/** Windows：dsh 的「可改项目文件夹」沙箱要求当前用户对文件夹有完全控制（D 盘的目录默认只给「修改」） */
function grantFullControl(folder: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const name = os.userInfo().username;
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
  return new Promise((resolve, reject) => {
    const child = spawn('icacls', [folder, '/grant', `${user}:(OI)(CI)F`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('没能给这个文件夹加上你自己的完全控制权限，换一个你自己建的文件夹')),
    );
  });
}

export function createDeviceClient(deps: {
  /** 桌面版自己的数据目录（Electron 的 userData） */
  dataDir: string;
  /** 网页地址的 origin，如 http://127.0.0.1:5173：经它连 Oasis，dsh 也经它调模型和工具 */
  webOrigin: string;
  /** 现在的登录 Cookie（oasis_session=…）；没登录为 undefined */
  cookie: () => Promise<string | undefined>;
  runtime: DshRuntime;
  log: (line: string) => void;
}) {
  const stateFile = path.join(deps.dataDir, 'device.json');
  const state = loadState(stateFile);
  const runs = new Map<string, ChildProcess>();
  let socket: WebSocket | undefined;
  let connected = false;
  let closed = false;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: NodeJS.Timeout | undefined;
  let silentTimer: NodeJS.Timeout | undefined;

  const homeOf = (workspaceId: string) => path.join(deps.dataDir, 'dsh', workspaceId);
  const save = () => writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  /** 这个会话在这个项目文件夹里的位置；没在这台电脑上选过的文件夹不认 */
  function placeOf(folder: string, workspaceId: string): Place {
    if (!state.folders.some((chosen) => sameFolder(chosen, folder)))
      throw new Error(
        `这个文件夹没在这台电脑的 Oasis 里选过：${folder}。在私聊的「在哪干活」里重新选一次`,
      );
    return { project: path.resolve(folder), home: homeOf(workspaceId), origin: deps.webOrigin };
  }

  function send(message: DeviceMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  async function reply(
    id: string,
    work: () => Promise<{ ok?: boolean; data?: string } | void>,
  ): Promise<void> {
    try {
      const result = (await work()) ?? {};
      send({
        type: 'reply',
        id,
        ok: result.ok ?? true,
        ...(result.data ? { data: result.data } : {}),
      });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 4000);
      deps.log(`没做成：${error}`);
      send({ type: 'reply', id, ok: false, error });
    }
  }

  /** 起 dsh：先准备好家目录（第一次要装 dsh），放好平台的文件，再在项目文件夹里起 */
  async function start(message: Extract<HarnessMessage, { type: 'start' }>) {
    const { runId } = message;
    const place = placeOf(message.folder, message.workspaceId);
    if (!existsSync(place.project)) throw new Error(`项目文件夹不在了：${place.project}`);
    const problem = deps.runtime.problem();
    if (problem) throw new Error(problem);
    const dsh = await deps.runtime.prepare(place.home, (status) =>
      send({ type: 'progress', runId, status }),
    );
    for (const { dir, tar } of message.files)
      await extractTar(placePath(dir, place), Buffer.from(tar, 'base64'));
    await mkdir(path.join(place.project, '.oasis'), { recursive: true });
    await writeFile(path.join(place.project, '.oasis', '.gitignore'), '*\n');

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(message.env))
      if (ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
        env[key] = resolvePlace(value, place);
    Object.assign(env, dsh.env, { DSH_HOME: place.home });
    // oasis-tool、oasis-op 在这个会话家目录的 bin/ 里；安装包自带的 Node 也放进去（Windows 上环境变量名是 Path）
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = [path.join(place.home, 'bin'), ...dsh.path, env[pathKey]]
      .filter(Boolean)
      .join(path.delimiter);

    const child = spawn(dsh.command, dsh.args, {
      cwd: place.project,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 其他系统上自成一组，结束时连它起的命令一起结束
      detached: process.platform !== 'win32',
    });
    runs.set(runId, child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => send({ type: 'stdout', runId, data }));
    child.stderr.on('data', (data: string) => send({ type: 'stderr', runId, data }));
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => deps.log(`dsh 起不来：${err.message}`));
    child.on('close', (code) => {
      runs.delete(runId);
      send({ type: 'exit', runId, code });
    });
    deps.log(`开始干活：${place.project}`);
  }

  async function handle(raw: string) {
    let message: HarnessMessage;
    try {
      message = HarnessMessage.parse(JSON.parse(raw));
    } catch {
      deps.log('看不懂 Oasis 发来的消息，丢掉');
      return;
    }
    switch (message.type) {
      case 'start':
        return reply(message.id, () => start(message));
      case 'stdin':
        runs.get(message.runId)?.stdin?.write(message.data);
        return;
      case 'stop': {
        const child = runs.get(message.runId);
        if (child) kill(child);
        return;
      }
      case 'read':
        return reply(message.id, async () => {
          const place = placeOf(message.folder, message.workspaceId);
          const data = await packPath(placePath(message.path, place));
          return data ? { data: data.toString('base64') } : { ok: false };
        });
      case 'list':
        return reply(message.id, async () => {
          const place = placeOf(message.folder, message.workspaceId);
          return { data: JSON.stringify(await listFiles(placePath(message.path, place))) };
        });
      case 'exists':
        return reply(message.id, async () => ({
          ok: existsSync(path.join(homeOf(message.workspaceId), 'sessions')),
        }));
      case 'purge':
        return reply(message.id, () =>
          rm(homeOf(message.workspaceId), { recursive: true, force: true }),
        );
    }
  }

  function stopAll() {
    for (const child of runs.values()) kill(child);
    runs.clear();
  }

  function alive() {
    clearTimeout(silentTimer);
    silentTimer = setTimeout(() => socket?.terminate(), SILENT_MS);
  }

  function retryLater() {
    clearTimeout(retryTimer);
    if (closed) return;
    retryTimer = setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  async function connect() {
    clearTimeout(retryTimer);
    if (closed || socket) return;
    const cookie = await deps.cookie();
    // 没登录：登录后（Cookie 有了）再连
    if (!cookie || closed || socket) return;
    const url = new URL('/api/harness/v1/devices/connect', deps.webOrigin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device', state.deviceId);
    const ws = new WebSocket(url, {
      headers: { cookie, origin: deps.webOrigin },
      maxPayload: MAX_PAYLOAD,
    });
    socket = ws;
    ws.on('open', () => {
      retryMs = RETRY_MIN_MS;
      connected = true;
      alive();
      send({
        type: 'hello',
        name: os.hostname().slice(0, 200),
        platform: process.platform,
        problem: deps.runtime.problem(),
      });
      deps.log('连上 Oasis 了，可以在这台电脑上干活');
    });
    ws.on('ping', alive);
    ws.on('message', (raw) => void handle(String(raw)));
    ws.on('error', (err) => deps.log(`连 Oasis 出错：${err.message}`));
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = undefined;
      connected = false;
      clearTimeout(silentTimer);
      stopAll();
      retryLater();
    });
  }

  /** 断开现在的连接，不再重连；正在跑的 dsh 都结束 */
  function disconnect() {
    const old = socket;
    socket = undefined;
    connected = false;
    clearTimeout(silentTimer);
    clearTimeout(retryTimer);
    old?.terminate();
    stopAll();
    retryMs = RETRY_MIN_MS;
  }

  return {
    /** 开始连 Oasis；第一次用时先存下这台电脑的设备号 */
    async start() {
      if (!existsSync(stateFile)) {
        await mkdir(deps.dataDir, { recursive: true });
        await save();
      }
      void connect();
    },

    status: (): DesktopDevice => ({
      deviceId: state.deviceId,
      connected,
      problem: deps.runtime.problem(),
    }),

    /** 用户选了一个项目文件夹：记下来（以后只在选过的文件夹里干活），Windows 上先给自己加上完全控制 */
    async allowFolder(folder: string): Promise<DesktopProjectFolder> {
      const resolved = path.resolve(folder);
      await grantFullControl(resolved);
      if (!state.folders.some((chosen) => sameFolder(chosen, resolved))) {
        state.folders.push(resolved);
        await save();
      }
      return { deviceId: state.deviceId, folder: resolved };
    },

    /** 登录状态变了：登出就断开，登录了（还没连上）就马上连 */
    signedIn(yes: boolean) {
      if (!yes) disconnect();
      else if (!socket) {
        retryMs = RETRY_MIN_MS;
        void connect();
      }
    },

    /** 桌面版退出：断开，结束正在跑的 dsh */
    close() {
      closed = true;
      disconnect();
    },
  };
}

export type DeviceClient = ReturnType<typeof createDeviceClient>;
