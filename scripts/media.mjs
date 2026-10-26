#!/usr/bin/env node
// 免费媒体基础验证：真实对象存储/HTTP/Docker/桌面文件链路，不发模型或供应商请求。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { createObjectStore, createService } from '../packages/service-kit/dist/index.js';
import { registerRoutes } from '../services/canvas/dist/api/routes.js';
import { createUploadService } from '../services/canvas/dist/service/upload-service.js';
import { createArtifactService } from '../services/canvas/dist/service/artifact-service.js';
import { memoryArtifacts, memoryUploads } from '../services/canvas/test/memory.ts';
import { createSyncFolder } from '../apps/desktop/dist/sync-folder.js';
import {
  createDockerApi,
  defaultDockerSocket,
} from '../services/harness/dist/executor/docker-api.js';
import { demultiplex, inspectSandboxMedia } from '../services/harness/src/executor/executor.ts';
import { packStreams } from '../services/harness/dist/executor/tar.js';

const root = path.resolve(import.meta.dirname, '..');
const env = path.join(root, 'services/canvas/.env');
if (existsSync(env)) process.loadEnvFile(env);
const bytes = Number(process.env.MEDIA_SMOKE_BYTES ?? 512 * 1024 * 1024);
assert(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 512 * 1024 * 1024);
const block = Buffer.alloc(64 * 1024, 37);
function source() {
  return Readable.from(
    (async function* () {
      for (let n = 0; n < bytes; n += block.length)
        yield block.subarray(0, Math.min(block.length, bytes - n));
    })(),
  );
}
async function digest(stream) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const value of stream) {
    size += value.length;
    hash.update(value);
  }
  return { size, sha256: hash.digest('hex') };
}
const expected = await digest(source());
const objects = createObjectStore({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY,
  bucket: process.env.S3_BUCKET ?? 'oasis-canvas',
});
if (process.argv[2] === 'recover') {
  await objects.ensureBucket();
  try {
    const directory = path.join(root, '.tmp');
    for (const name of await readdir(directory).catch(() => [])) {
      if (!/^media-smoke-[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      const record = JSON.parse(await readFile(file, 'utf8'));
      assert(/^[a-f0-9-]{36}$/.test(record.taskId) && /^[a-f0-9-]{36}$/.test(record.ownerId));
      let alive = false;
      try {
        process.kill(record.pid, 0);
        alive = true;
      } catch {
        /* 已停止 */
      }
      if (alive) throw new Error('验收进程仍在运行，不能清理');
      for (const key of record.keys) {
        assert(
          [
            `uploads/${record.ownerId}/`,
            `artifacts/${record.taskId}/`,
            `media-test/${record.taskId}/`,
          ].some((prefix) => key.startsWith(prefix)),
        );
        await objects.store.delete(key);
      }
      await createDockerApi(defaultDockerSocket()).removeContainer(
        `oasis-media-check-${record.taskId}`,
      );
      assert.equal(path.dirname(path.resolve(record.temp)), path.resolve(os.tmpdir()));
      assert(path.basename(record.temp).startsWith('oasis-media-'));
      assert.equal(
        await readFile(path.join(record.temp, '.oasis-media-task'), 'utf8'),
        record.taskId,
      );
      await rm(record.temp, { recursive: true, force: true });
      await rm(file);
      console.log(`已回收中断验收 ${record.taskId}`);
    }
  } finally {
    await objects.resource.close();
  }
  process.exit(0);
}
const output = path.resolve(
  root,
  process.env.MEDIA_SMOKE_OUTPUT ?? 'out/media-foundation-acceptance',
);
assert(
  output.startsWith(path.join(root, 'out') + path.sep) && !existsSync(output),
  '选择 out/ 下新的媒体验收目录，不能覆盖已有报告',
);
const keys = new Set();
let journalPath;
let journal;
const persist = () => {
  if (journalPath) writeFileSync(journalPath, JSON.stringify({ ...journal, keys: [...keys] }));
};
const store = {
  ...objects.store,
  async put(key, body, type) {
    keys.add(key);
    persist();
    return objects.store.put(key, body, type);
  },
  async putStream(key, body, type, limits) {
    keys.add(key);
    persist();
    return objects.store.putStream(key, body, type, limits);
  },
};
const ownerId = randomUUID();
const taskId = randomUUID();
const nodeId = randomUUID();
const uploadRepo = memoryUploads();
const artifactRepo = memoryArtifacts();
const uploads = createUploadService({ repo: uploadRepo, store });
let address;
let uploaded;
const artifacts = createArtifactService({
  repo: artifactRepo,
  store,
  logger: { info() {} },
  task: {
    async json() {
      return {
        nodes: [{ id: nodeId, model: 'offline-test' }],
        deliverables: [],
        deliveryFiles: [{ nodeId, path: 'source.bin', deliverable: '压力样例' }],
      };
    },
    async stream() {
      return fetch(`${address}/v1/uploads/${uploaded.id}`, {
        headers: { 'x-oasis-user-id': ownerId },
      });
    },
  },
});
const service = await createService(
  {
    name: 'media-check',
    env: {},
    routes: (app) =>
      registerRoutes(
        app,
        { uploads, artifacts, store },
        { maxBytes: 512 * 1024 * 1024, archive: { bytes: 2 * 1024 ** 3, files: 1000 } },
      ),
  },
  { PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SHUTDOWN_DRAIN_MS: '0' },
);
const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-media-'));
await writeFile(path.join(temp, '.oasis-media-task'), taskId);
await mkdir(path.join(root, '.tmp'), { recursive: true });
journalPath = path.join(root, '.tmp', `media-smoke-${taskId}.json`);
journal = { taskId, ownerId, temp, pid: process.pid };
persist();
const docker = createDockerApi(defaultDockerSocket());
let container;
let peak = process.memoryUsage().rss;
const memory = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
const report = {
  bytes,
  sha256: expected.sha256,
  checks: [],
  audio: null,
  peakRssBytes: 0,
  stages: [],
};
function checked(label) {
  const memory = process.memoryUsage();
  report.checks.push(label);
  report.stages.push({ label, peak, ...memory });
  console.log(
    `通过：${label}；RSS ${(memory.rss / 1024 ** 2).toFixed(1)} MiB，峰值 ${(peak / 1024 ** 2).toFixed(1)} MiB`,
  );
}
async function exec(cmd) {
  const execution = await docker.exec(container, cmd);
  const output = new PassThrough();
  const errors = new PassThrough();
  errors.resume();
  demultiplex(execution.stream, output, errors);
  const chunks = [];
  for await (const chunk of output) chunks.push(chunk);
  const state = await docker.inspectExec(execution.id);
  assert.equal(state.ExitCode, 0, '容器验证命令失败');
  return Buffer.concat(chunks).toString('utf8');
}
try {
  await objects.ensureBucket();
  address = await service.listen();
  uploaded = await new Promise((resolve, reject) => {
    const request = http.request(
      `${address}/v1/uploads?name=source.bin`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': bytes,
          'x-oasis-user-id': ownerId,
        },
      },
      (response) => {
        const parts = [];
        let size = 0;
        response.on('data', (part) => {
          size += part.length;
          if (size > 16_384) response.destroy(new Error('上传响应过大'));
          else parts.push(part);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 201);
            resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    void pipeline(source(), request).catch(reject);
  });
  assert.equal(uploaded.size, bytes);
  assert.equal(uploaded.sha256, expected.sha256);
  checked('HTTP 上传 → 真实 S3 分段写入与 SHA-256');
  const range = await fetch(`${address}/v1/uploads/${uploaded.id}`, {
    headers: { 'x-oasis-user-id': ownerId, range: 'bytes=1000-1999' },
  });
  assert.equal(range.status, 206);
  assert(Buffer.from(await range.arrayBuffer()).equals(Buffer.alloc(1000, 37)));
  checked('鉴权 Range 下载');
  await artifacts.onTaskStatus({
    status: 'succeeded',
    taskId,
    ownerId,
    title: '媒体基础验收',
    conversationId: null,
  });
  const artifact = artifactRepo.rows[0];
  assert.equal(artifact.size, bytes);
  assert.equal(artifact.sha256, expected.sha256);
  checked('最终成果跨 HTTP 流式复制与摘要核对');
  const zipResponse = await fetch(`${address}/v1/tasks/${taskId}/archive`, {
    headers: { 'x-oasis-user-id': ownerId },
  });
  assert.equal(zipResponse.status, 200);
  const require = createRequire(path.join(root, 'services/canvas/package.json'));
  const { Unzip } = require('fflate');
  let zipSize = 0;
  let zipHash;
  let zipError;
  const unzip = new Unzip((file) => {
    const hash = createHash('sha256');
    file.ondata = (error, data, final) => {
      if (error) zipError = error;
      else {
        zipSize += data.length;
        hash.update(data);
        if (final) zipHash = hash.digest('hex');
      }
    };
    file.start();
  });
  for await (const chunk of Readable.fromWeb(zipResponse.body)) unzip.push(chunk);
  unzip.push(new Uint8Array(), true);
  if (zipError) throw zipError;
  assert.equal(zipSize, bytes);
  assert.equal(zipHash, expected.sha256);
  checked('流式 ZIP 打包/解包逐字节验证');
  const sync = createSyncFolder(path.join(temp, 'sync.json'));
  await sync.setFolder(path.join(temp, 'artifacts'));
  const token = await sync.begin(artifact.id, artifact.syncPath, artifact.size, artifact.sha256);
  const content = await fetch(`${address}/v1/artifacts/${artifact.id}/content`, {
    headers: { 'x-oasis-user-id': ownerId },
  });
  for await (const chunk of Readable.fromWeb(content.body))
    for (let offset = 0; offset < chunk.length; offset += 1024 * 1024)
      await sync.append(token, chunk.subarray(offset, offset + 1024 * 1024));
  await sync.finish(token);
  assert.deepEqual(
    await digest(createReadStream(path.join(temp, 'artifacts', artifact.syncPath))),
    expected,
  );
  checked('桌面分块写入、摘要核对与原子完成');
  const failedKey = `media-test/${taskId}/incomplete`;
  await assert.rejects(
    store.putStream(failedKey, Readable.from([Buffer.from('short')]), 'application/octet-stream', {
      maxBytes: 100,
      size: 90,
    }),
  );
  await assert.rejects(store.get(failedKey));
  checked('截断分段上传中止，不产生完整对象');
  const staleId = randomUUID();
  const staleKey = `media-test/${taskId}/stale`;
  await store.put(staleKey, Buffer.from('unfinished'), 'application/octet-stream');
  const stale = await uploadRepo.insert({
    id: staleId,
    ownerId,
    state: 'uploading',
    name: 'unfinished',
    size: 0,
    sha256: null,
    contentType: 'application/octet-stream',
    objectKey: staleKey,
  });
  stale.createdAt = new Date(Date.now() - 25 * 3600_000);
  uploads.start();
  for (let n = 0; n < 100 && (await uploadRepo.find(staleId)); n++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await uploadRepo.find(staleId), undefined);
  await assert.rejects(store.get(staleKey));
  checked('未完成上传记录重启恢复清理');
  const created = await docker.createContainer(`oasis-media-check-${taskId}`, {
    Image: process.env.SANDBOX_IMAGE ?? 'oasis/harness-sandbox-base:0.2.1-rc.2',
    Entrypoint: ['node', '-e', 'setInterval(()=>{},1000)'],
    Labels: { 'oasis.component': 'media-check' },
    HostConfig: {
      NetworkMode: 'none',
      NanoCpus: 2e9,
      Memory: 2 * 1024 ** 3,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
  });
  container = created.Id;
  const row = await uploadRepo.find(uploaded.id);
  await docker.putArchive(
    container,
    '/workspace',
    packStreams([
      {
        path: 'materials/source.bin',
        size: bytes,
        sha256: expected.sha256,
        open: () => store.read(row.objectKey),
      },
    ]),
  );
  await docker.startContainer(container);
  const transferred = JSON.parse(
    await exec([
      'node',
      '-e',
      "const fs=require('node:fs'),c=require('node:crypto');const h=c.createHash('sha256');let n=0;const s=fs.createReadStream('/workspace/materials/source.bin');s.on('data',b=>{n+=b.length;h.update(b)});s.on('end',()=>console.log(JSON.stringify({size:n,sha256:h.digest('hex')})))",
    ]),
  );
  assert.deepEqual(transferred, expected);
  checked('真实 Docker tar 流式素材传入');
  await exec([
    'ffmpeg',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '90',
    '/workspace/out/tone.wav',
  ]);
  await exec([
    'node',
    '-e',
    "require('node:fs').writeFileSync('/workspace/out/broken.mp3','not audio')",
  ]);
  const snapshot = await docker.getArchive(container, '/workspace/out');
  const snapshotKey = `media-test/${taskId}/audio-snapshot.tar`;
  await store.putStream(snapshotKey, snapshot, 'application/x-tar', { maxBytes: 32 * 1024 * 1024 });
  const audio = await inspectSandboxMedia(docker, container, await store.read(snapshotKey), {
    files: 20,
    timeoutMs: 90_000,
    durationMs: 1200_000,
    maxBytes: 2 * 1024 ** 3,
  });
  assert.equal(audio.files.find((file) => file.path === 'tone.wav')?.valid, true);
  assert.equal(audio.files.find((file) => file.path === 'broken.mp3')?.valid, false);
  report.audio = audio;
  checked('真实 FFprobe/FFmpeg：90 秒音频完整解码，损坏 MP3 被拒绝');
  await exec([
    'node',
    '-e',
    "const fs=require('node:fs');const d=fs.readdirSync('/tmp').find(n=>n.startsWith('oasis-media-'));try{fs.writeFileSync('/tmp/'+d+'/tone.wav','changed');process.exit(2)}catch(e){if(e.code!=='EACCES')throw e}",
  ]);
  checked('受信检查快照对沙箱用户只读');
  report.peakRssBytes = peak;
  if (bytes >= 256 * 1024 * 1024) assert(peak < bytes, `内存峰值 ${peak} 未达到流式目标`);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    path.join(output, 'README.md'),
    `# 媒体数据面免费工程验证\n\n输入 ${bytes / 1024 ** 2} MiB，SHA-256 ${expected.sha256}。\n\n${report.checks.map((check) => `- 通过：${check}`).join('\n')}\n\nNode RSS 峰值 ${(peak / 1024 ** 2).toFixed(1)} MiB。本轮未发起模型或供应商请求；不等同于真实音乐成品验收。测试对象、文件与容器在 finally 回收。\n`,
  );
  console.log(
    `媒体基础验证通过：${bytes / 1024 ** 2} MiB，RSS 峰值 ${(peak / 1024 ** 2).toFixed(1)} MiB，${report.checks.length} 项；报告 ${output}`,
  );
} finally {
  clearInterval(memory);
  uploads.close();
  if (container) await docker.removeContainer(container);
  await service.stop();
  for (const key of keys) await objects.store.delete(key);
  await objects.resource.close();
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert(path.basename(temp).startsWith('oasis-media-'));
  assert.equal(await readFile(path.join(temp, '.oasis-media-task'), 'utf8'), taskId);
  await rm(temp, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}
