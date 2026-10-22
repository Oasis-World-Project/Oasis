// Docker Engine API 的最小客户端：只用 Node 自带的 http，经 Unix socket 或 Windows 命名管道访问。
// harness 只需要建容器、拷文件进出、接上 stdin/stdout、停止和列出容器，用不着完整的 SDK。
import http from 'node:http';
import type { Duplex, Readable } from 'node:stream';

/** API 版本：Docker Engine 25 起支持 */
const API = '/v1.44';

class DockerApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
  }
}

export function defaultDockerSocket(platform = process.platform): string {
  return platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createDockerApi(socketPath: string) {
  function send(
    method: string,
    path: string,
    options: { json?: unknown; body?: Buffer; contentType?: string } = {},
  ): Promise<http.IncomingMessage> {
    const body =
      options.json === undefined ? options.body : Buffer.from(JSON.stringify(options.json));
    const contentType = options.json === undefined ? options.contentType : 'application/json';
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path: `${API}${path}`,
          headers: {
            ...(contentType ? { 'content-type': contentType } : {}),
            ...(body ? { 'content-length': body.length } : {}),
          },
        },
        resolve,
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /** 发请求；非 2xx 时读出 Docker 的错误信息并抛出 */
  async function call(
    method: string,
    path: string,
    options?: Parameters<typeof send>[2],
  ): Promise<http.IncomingMessage> {
    const res = await send(method, path, options);
    const status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) return res;
    const text = (await readAll(res)).toString('utf8');
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // 不是 JSON，原样使用
    }
    throw new DockerApiError(status, `Docker ${method} ${path} → ${status}：${message.trim()}`);
  }

  async function json<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await call(method, path, payload === undefined ? {} : { json: payload });
    const text = (await readAll(res)).toString('utf8');
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    ping: async () => {
      await readAll(await call('GET', '/_ping'));
    },
    imageExists: async (image: string) => {
      try {
        await json('GET', `/images/${encodeURIComponent(image)}/json`);
        return true;
      } catch (err) {
        if (err instanceof DockerApiError && err.status === 404) return false;
        throw err;
      }
    },
    networkExists: async (network: string) => {
      try {
        await json('GET', `/networks/${encodeURIComponent(network)}`);
        return true;
      } catch (err) {
        if (err instanceof DockerApiError && err.status === 404) return false;
        throw err;
      }
    },
    createContainer: (name: string, spec: Record<string, unknown>) =>
      json<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec),
    startContainer: async (id: string) => {
      await readAll(await call('POST', `/containers/${id}/start`));
    },
    /** 把一个 tar 包解到容器里的目录（目录必须已存在） */
    putArchive: async (id: string, dir: string, tar: Buffer) => {
      const query = `path=${encodeURIComponent(dir)}`;
      await readAll(
        await call('PUT', `/containers/${id}/archive?${query}`, {
          body: tar,
          contentType: 'application/x-tar',
        }),
      );
    },
    /** 把容器里的一个路径打成 tar 流取出来；路径不存在时返回 undefined */
    getArchive: async (id: string, path: string): Promise<Readable | undefined> => {
      try {
        return await call('GET', `/containers/${id}/archive?path=${encodeURIComponent(path)}`);
      } catch (err) {
        if (err instanceof DockerApiError && err.status === 404) return undefined;
        throw err;
      }
    },
    /** 接上容器的 stdin/stdout/stderr（必须在 start 之前），返回原始双向连接 */
    attach: (id: string) =>
      new Promise<Duplex>((resolve, reject) => {
        const req = http.request({
          socketPath,
          method: 'POST',
          path: `${API}/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
          headers: { connection: 'Upgrade', upgrade: 'tcp' },
        });
        req.on('upgrade', (_res, socket, head) => {
          if (head.length > 0) socket.unshift(head);
          resolve(socket);
        });
        req.on('response', (res) => {
          void readAll(res).then((body) =>
            reject(
              new DockerApiError(res.statusCode ?? 0, `attach 失败：${body.toString('utf8')}`),
            ),
          );
        });
        req.on('error', reject);
        req.end();
      }),
    /** 强制删除（运行中的会先被杀掉），连同匿名卷；容器不存在不算错 */
    removeContainer: async (id: string) => {
      try {
        await readAll(await call('DELETE', `/containers/${id}?force=1&v=1`));
      } catch (err) {
        if (!(err instanceof DockerApiError && err.status === 404)) throw err;
      }
    },
    listContainers: (label: string) =>
      json<{ Id: string; Labels: Record<string, string> }[]>(
        'GET',
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`,
      ),
  };
}

export type DockerApi = ReturnType<typeof createDockerApi>;
