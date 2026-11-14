// 用户自己的电脑当执行环境：桌面版经 gateway 连上来（WebSocket，协议见 @oasis/contracts/device），
// harness 把一轮交给它在用户选的项目文件夹里起 dsh。接口和 Docker 执行器一样：起进程、标准输入输出、
// 取文件、结束；会话（dsh 的家目录）在那台电脑上，按会话分开放。只用这个人自己连上来的电脑。
// 连接只在这个进程里（多实例部署时要按用户把连接和运行放到同一个实例上）。
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import { DeviceMessage, type HarnessMessage } from '@oasis/contracts/device';
import { DEVICE_OFFLINE, type Workplace } from '@oasis/contracts/harness';
import { HttpError, readLimited, type Logger } from '@oasis/service-kit';
import type { WebSocket } from 'ws';
import type { Executor, Sandbox } from './executor.ts';

type DeviceWorkplace = Extract<Workplace, { kind: 'device' }>;

/** 等桌面版回话最多多久；起 dsh 时第一次要在那台电脑上装 dsh（约 3 分钟），给足时间 */
const REPLY_MS = 60_000;
const START_MS = 15 * 60_000;
/** 隔多久确认一次连接还活着（中间的代理会断开长时间没动静的连接） */
const PING_MS = 25_000;
/** 一次交给电脑或从电脑取回的文件最多多大 */
const FILES_MAX_BYTES = 512 * 1024 * 1024;
/** 一轮做到一半电脑断开：这一轮停下，会话还在那台电脑上，下一轮接着做 */
const DISCONNECTED =
  '你的电脑断开了（桌面版关了或断网），这一轮停在这里；打开桌面版后说「继续」接着做';

type Reply = Extract<DeviceMessage, { type: 'reply' }>;
interface DeviceRun {
  workspaceId: string;
  stdout: PassThrough;
  stderr: PassThrough;
  notify?: (status: string) => void;
}
interface Connection {
  socket: WebSocket;
  problem: string | null;
  replies: Map<string, (reply: Reply) => void>;
  runs: Map<string, DeviceRun>;
}

export function createDeviceHub(deps: {
  logger: Logger;
  /** 沙箱里的目录 → 电脑上的位置（{project}、{home} 由桌面版换成实际的），长的在前 */
  paths: [sandbox: string, device: string][];
}) {
  const connections = new Map<string, Connection>();
  const keyOf = (userId: string, deviceId: string) => `${userId}:${deviceId}`;

  function toDevice(path: string): string {
    for (const [from, to] of deps.paths)
      if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
    throw new Error(`电脑上没有对应的位置：${path}`);
  }

  function send(connection: Connection, message: HarnessMessage) {
    connection.socket.send(JSON.stringify(message));
  }

  async function ask(
    connection: Connection,
    message: HarnessMessage & { id: string },
    timeoutMs = REPLY_MS,
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.replies.delete(message.id);
        reject(new HttpError(504, 'device_timeout', '你的电脑没有回应，稍后再试'));
      }, timeoutMs);
      connection.replies.set(message.id, (reply) => {
        clearTimeout(timer);
        connection.replies.delete(message.id);
        resolve(reply);
      });
      send(connection, message);
    });
  }

  async function read(connection: Connection, folder: string, workspaceId: string, path: string) {
    const reply = await ask(connection, {
      type: 'read',
      id: randomUUID(),
      folder,
      workspaceId,
      path: toDevice(path),
    });
    return reply.ok && reply.data ? Readable.from([Buffer.from(reply.data, 'base64')]) : undefined;
  }

  function attach(socket: WebSocket, userId: string, deviceId: string) {
    const key = keyOf(userId, deviceId);
    connections.get(key)?.socket.close(4000, '这台电脑又连上来了，旧的连接不用了');
    const connection: Connection = { socket, problem: null, replies: new Map(), runs: new Map() };
    connections.set(key, connection);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on('pong', () => (alive = true));
    socket.on('message', (raw) => {
      let message: DeviceMessage;
      try {
        message = DeviceMessage.parse(JSON.parse(String(raw)));
      } catch (err) {
        deps.logger.warn({ err, deviceId }, '电脑发来的消息看不懂，丢掉');
        return;
      }
      const run = 'runId' in message ? connection.runs.get(message.runId) : undefined;
      if (message.type === 'hello') {
        connection.problem = message.problem;
        deps.logger.info(
          { deviceId, platform: message.platform, problem: message.problem },
          '电脑连上了',
        );
      } else if (message.type === 'reply') connection.replies.get(message.id)?.(message);
      else if (message.type === 'stdout') run?.stdout.write(message.data);
      else if (message.type === 'stderr') run?.stderr.write(message.data);
      else if (message.type === 'progress') run?.notify?.(message.status);
      else if (message.type === 'exit' && run) {
        connection.runs.delete(message.runId);
        run.stdout.end();
        run.stderr.end();
      }
    });
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (connections.get(key) === connection) connections.delete(key);
      for (const run of connection.runs.values()) {
        run.stdout.destroy(new Error(DISCONNECTED));
        run.stderr.end();
      }
      connection.runs.clear();
      for (const answer of connection.replies.values())
        answer({ type: 'reply', id: '', ok: false, error: DISCONNECTED });
      deps.logger.info({ deviceId }, '电脑断开了');
    });
  }

  /** 这个人这台电脑、这个项目文件夹上的执行器（电脑没连上时报 409 device_offline） */
  function executor(userId: string, workplace: DeviceWorkplace): Executor {
    const { deviceId, folder } = workplace;
    const connected = () => {
      const connection = connections.get(keyOf(userId, deviceId));
      if (!connection)
        throw new HttpError(
          409,
          DEVICE_OFFLINE,
          '你的电脑没连上 Oasis：在那台电脑上打开 Oasis 桌面版（登录同一个账号），再发一次',
        );
      return connection;
    };
    const answer = async (message: HarnessMessage & { id: string }) => {
      const reply = await ask(connected(), message);
      if (!reply.ok && reply.error) throw new HttpError(502, 'device_failed', reply.error);
      return reply.ok;
    };
    return {
      async check() {
        const { problem } = connected();
        if (problem) throw new HttpError(409, 'device_unready', problem);
      },
      async start(spec) {
        const connection = connected();
        const run: DeviceRun = {
          workspaceId: spec.workspaceId,
          stdout: new PassThrough({ encoding: 'utf8' }),
          stderr: new PassThrough({ encoding: 'utf8' }),
          ...(spec.notify ? { notify: spec.notify } : {}),
        };
        connection.runs.set(spec.runId, run);
        try {
          const files = await Promise.all(
            spec.files.map(async ({ dir, tar }) => ({
              dir: toDevice(dir),
              tar: (Buffer.isBuffer(tar) ? tar : await readLimited(tar, FILES_MAX_BYTES)).toString(
                'base64',
              ),
            })),
          );
          const reply = await ask(
            connection,
            {
              type: 'start',
              id: randomUUID(),
              runId: spec.runId,
              folder,
              workspaceId: spec.workspaceId,
              env: spec.env,
              files,
            },
            START_MS,
          );
          if (!reply.ok) throw new Error(reply.error ?? '你的电脑没能起 dsh');
        } catch (err) {
          connection.runs.delete(spec.runId);
          throw err;
        }
        let stopped = false;
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          if (connections.get(keyOf(userId, deviceId)) === connection)
            send(connection, { type: 'stop', runId: spec.runId });
        };
        const sandbox: Sandbox = {
          id: `device-${deviceId}-${spec.runId}`,
          stdin: new Writable({
            decodeStrings: false,
            write(chunk: string | Buffer, _encoding, done) {
              if (connection.socket.readyState !== connection.socket.OPEN)
                return done(new Error(DISCONNECTED));
              send(connection, { type: 'stdin', runId: spec.runId, data: String(chunk) });
              done();
            },
          }),
          stdout: run.stdout,
          stderr: run.stderr,
          readArchive: (path) => read(connection, folder, spec.workspaceId, path),
          // 用户电脑上不一定装了 LibreOffice：Word、PPT 不配 PDF
          exec: async () => {
            throw new Error('用户电脑上不跑平台的命令');
          },
          pause: stop,
          destroy: stop,
        };
        return sandbox;
      },
      removeOrphans: async () => 0,
      workspaceExists: (sessionId) =>
        answer({ type: 'exists', id: randomUUID(), workspaceId: sessionId }),
      async purgeWorkspace(sessionId) {
        await answer({ type: 'purge', id: randomUUID(), workspaceId: sessionId });
      },
      async readStoredArchive(runId, path) {
        const connection = connections.get(keyOf(userId, deviceId));
        const run = connection?.runs.get(runId);
        return connection && run ? read(connection, folder, run.workspaceId, path) : undefined;
      },
    };
  }

  return {
    attach,
    executor,
    /** 服务关闭：断开所有电脑（它们会自己重连） */
    close() {
      for (const connection of connections.values()) connection.socket.close(1001, '服务重启');
    },
  };
}

export type DeviceHub = ReturnType<typeof createDeviceHub>;
