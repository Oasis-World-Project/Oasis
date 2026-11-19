// 在你的电脑上干活：路径换成实际的、跳不出去；放进和取回文件；连上 Oasis 后起 dsh（这里用一个回声脚本代替）、
// 转发输入输出、只认选过的文件夹、环境变量只收 OASIS_ 和 DSH_ 开头的、结束、断开。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeviceMessage, type HarnessMessage } from '@oasis/contracts/device';
import { extract, pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createDeviceClient } from '../src/device.ts';
import { extractTar, packPath, placePath, resolvePlace } from '../src/device-files.ts';
import { nodeProblem } from '../src/dsh-runtime.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'oasis-device-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function tarOf(files: Record<string, string>): Promise<Buffer> {
  const archive = pack();
  for (const [name, content] of Object.entries(files)) archive.entry({ name }, content);
  archive.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of archive) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
async function namesIn(data: Buffer): Promise<string[]> {
  const reader = extract();
  reader.end(data);
  const names: string[] = [];
  for await (const entry of reader) {
    names.push(entry.header.name);
    entry.resume();
  }
  return names;
}

describe('电脑上的位置和文件', () => {
  it('{project}、{home}、{origin} 换成实际的；平台只碰项目的 .oasis/ 和会话的家目录', () => {
    const place = {
      project: path.join(root, 'blog'),
      home: path.join(root, 'dsh', 's1'),
      origin: 'http://127.0.0.1:5173',
    };
    expect(resolvePlace('{origin}/api/run/v1', place)).toBe('http://127.0.0.1:5173/api/run/v1');
    expect(resolvePlace('{project}/.oasis/in', place)).toBe(
      path.join(place.project, '.oasis', 'in'),
    );
    expect(placePath('{home}/tools', place)).toBe(path.join(place.home, 'tools'));
    for (const bad of ['{project}/src', '{project}/.oasis/../secret', '{home}/../s2', '/etc'])
      expect(() => placePath(bad, place)).toThrow('平台不能碰这个位置');
  });

  it('放进来的包不能跳出目录；取回时条目以被取的名字开头', async () => {
    const dir = path.join(root, '.oasis');
    await extractTar(dir, await tarOf({ 'in/a.txt': 'A', 'in/b/c.txt': 'C' }));
    expect(await readFile(path.join(dir, 'in', 'b', 'c.txt'), 'utf8')).toBe('C');
    await expect(extractTar(dir, await tarOf({ '../evil.txt': 'x' }))).rejects.toThrow('跳出目录');
    expect(existsSync(path.join(root, 'evil.txt'))).toBe(false);
    expect(await namesIn((await packPath(path.join(dir, 'in')))!)).toEqual([
      'in/',
      'in/a.txt',
      'in/b/',
      'in/b/c.txt',
    ]);
    expect(await namesIn((await packPath(path.join(dir, 'in', 'a.txt')))!)).toEqual(['a.txt']);
    expect(await packPath(path.join(dir, 'nope'))).toBeUndefined();
  });

  it('Node 版本：没装、太旧的说清楚；22.19 以上的 22 版和 24 以上能用', () => {
    expect(nodeProblem(undefined)).toContain('没装 Node.js');
    expect(nodeProblem('v20.11.0')).toContain('v20.11.0');
    expect(nodeProblem('v23.1.0')).toContain('要 24 版');
    expect(nodeProblem('v22.19.0')).toBeNull();
    expect(nodeProblem('v24.3.0')).toBeNull();
  });
});

/** 假 Oasis：桌面版连上来；测试发消息、等回话 */
async function fakeOasis() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const received: DeviceMessage[] = [];
  const upgrades: { url?: string; cookie?: string; origin?: string }[] = [];
  let socket: WebSocket | undefined;
  server.on('connection', (ws, request) => {
    upgrades.push({
      url: request.url,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
    });
    socket = ws;
    ws.on('message', (raw) => received.push(DeviceMessage.parse(JSON.parse(String(raw)))));
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    upgrades,
    send: (message: HarnessMessage) => socket!.send(JSON.stringify(message)),
    drop: () => socket?.terminate(),
    async until<T>(find: (message: DeviceMessage) => T | undefined | false, ms = 10_000) {
      for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        for (const message of received) {
          const found = find(message);
          if (found) return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('等不到');
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ECHO = `import { existsSync } from 'node:fs';
import path from 'node:path';
process.stdout.write(JSON.stringify({
  pid: process.pid,
  in: process.env.OASIS_IN,
  home: process.env.DSH_HOME,
  base: process.env.OASIS_MODEL_BASE_URL,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  cwd: process.cwd(),
  gitignore: existsSync('.oasis/.gitignore'),
  bin: (process.env.PATH ?? '').split(path.delimiter)[0],
}) + '\\n');
process.stdin.on('data', (data) => process.stdout.write(data));
`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('连上 Oasis 接活', () => {
  it(
    '起 dsh、转发输入输出、放进和取回文件、结束、清会话；只认选过的文件夹，环境变量只收 OASIS_ 和 DSH_ 开头的',
    { timeout: 30_000 },
    async () => {
      const oasis = await fakeOasis();
      const project = path.join(root, 'blog');
      await mkdir(project);
      const script = path.join(root, 'echo.mjs');
      await writeFile(script, ECHO);
      const dataDir = path.join(root, 'data');
      const client = createDeviceClient({
        dataDir,
        webOrigin: oasis.origin,
        cookie: async () => 'oasis_session=t',
        runtime: {
          problem: () => null,
          async prepare(home, onStatus) {
            onStatus('installing_dsh');
            await mkdir(home, { recursive: true });
            return {
              command: process.execPath,
              args: [script],
              env: { DSH_TELEMETRY_DISABLED: '1' },
              path: [],
            };
          },
        },
        log: () => undefined,
      });
      try {
        await client.start();
        expect(await oasis.until((m) => m.type === 'hello' && m)).toMatchObject({
          platform: process.platform,
          problem: null,
        });
        const { deviceId } = client.status();
        expect(oasis.upgrades[0]).toEqual({
          url: `/api/harness/v1/devices/connect?device=${deviceId}`,
          cookie: 'oasis_session=t',
          origin: oasis.origin,
        });
        expect(client.status().connected).toBe(true);

        const runId = randomUUID();
        const workspaceId = 'session-1';
        const home = path.join(dataDir, 'dsh', workspaceId);
        const reply = (id: string) => oasis.until((m) => m.type === 'reply' && m.id === id && m);
        const start: Extract<HarnessMessage, { type: 'start' }> = {
          type: 'start',
          id: 's1',
          runId,
          folder: project,
          workspaceId,
          env: {
            OASIS_IN: '{project}/.oasis/in',
            DSH_HOME: '{home}',
            OASIS_MODEL_BASE_URL: '{origin}/api/run/v1',
            NODE_OPTIONS: '--require=./evil.cjs',
          },
          files: [
            { dir: '{project}/.oasis', tar: (await tarOf({ 'in/a.txt': 'A' })).toString('base64') },
          ],
        };
        oasis.send(start);
        expect(await reply('s1')).toMatchObject({
          ok: false,
          error: expect.stringContaining('没在这台电脑的 Oasis 里选过'),
        });

        expect(await client.allowFolder(project)).toEqual({ deviceId, folder: project });
        oasis.send({ ...start, id: 's2' });
        expect(await reply('s2')).toMatchObject({ ok: true });
        expect(oasis.received).toContainEqual({
          type: 'progress',
          runId,
          status: 'installing_dsh',
        });
        const first = await oasis.until((m) => m.type === 'stdout' && m.runId === runId && m);
        const seen = JSON.parse(first.data.split('\n')[0]!) as Record<string, unknown>;
        expect(seen).toMatchObject({
          in: path.join(project, '.oasis', 'in'),
          home,
          base: `${oasis.origin}/api/run/v1`,
          cwd: project,
          gitignore: true,
          bin: path.join(home, 'bin'),
        });
        expect(seen.nodeOptions).not.toBe('--require=./evil.cjs');

        oasis.send({ type: 'stdin', runId, data: '{"ping":1}\n' });
        await oasis.until((m) => m.type === 'stdout' && m.data.includes('{"ping":1}'));

        oasis.send({
          type: 'read',
          id: 'r1',
          folder: project,
          workspaceId,
          path: '{project}/.oasis/in',
        });
        const read = await reply('r1');
        expect(await namesIn(Buffer.from(read.data!, 'base64'))).toEqual(['in/', 'in/a.txt']);
        oasis.send({ type: 'read', id: 'r2', folder: project, workspaceId, path: '{project}/src' });
        expect(await reply('r2')).toMatchObject({
          ok: false,
          error: expect.stringContaining('不能碰'),
        });

        oasis.send({ type: 'exists', id: 'e1', workspaceId });
        expect(await reply('e1')).toMatchObject({ ok: false });
        await mkdir(path.join(home, 'sessions'));
        oasis.send({ type: 'exists', id: 'e2', workspaceId });
        expect(await reply('e2')).toMatchObject({ ok: true });

        oasis.send({ type: 'stop', runId });
        await oasis.until((m) => m.type === 'exit' && m.runId === runId);
        oasis.send({ type: 'purge', id: 'p1', workspaceId });
        expect(await reply('p1')).toMatchObject({ ok: true });
        expect(existsSync(home)).toBe(false);

        // 断开时正在跑的 dsh 结束掉，随后自己重连
        const second = randomUUID();
        oasis.send({ ...start, id: 's3', runId: second });
        await reply('s3');
        const pid = (
          JSON.parse(
            (await oasis.until((m) => m.type === 'stdout' && m.runId === second && m)).data.split(
              '\n',
            )[0]!,
          ) as { pid: number }
        ).pid;
        oasis.drop();
        await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
        await expect.poll(() => oasis.upgrades.length, { timeout: 5_000 }).toBe(2);

        // 登出就断开、不再连；登录了再连
        client.signedIn(false);
        await expect.poll(() => client.status().connected).toBe(false);
        client.signedIn(true);
        await expect.poll(() => oasis.upgrades.length, { timeout: 5_000 }).toBe(3);
      } finally {
        client.close();
        await oasis.close();
      }
    },
  );
});
