#!/usr/bin/env node
// 免费视频/工程验证，与媒体数据面验证分开；只运行自制素材，不调模型供应商。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  createDockerApi,
  defaultDockerSocket,
  demultiplex,
  packFiles,
  scanArchive,
} from '../packages/service-kit/dist/index.js';
import { MEDIA_LABEL, runMediaCheck } from '../services/inspector/src/service/media-check.ts';

const root = path.resolve(import.meta.dirname, '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const output = path.resolve(
  root,
  process.env.VIDEO_SMOKE_OUTPUT ?? 'out/video-foundation-acceptance',
);
assert(
  output.startsWith(path.join(root, 'out') + path.sep) && !existsSync(output),
  '选择 out/ 下新的验收目录',
);
const image = process.env.SANDBOX_IMAGE ?? 'oasis/harness-sandbox-base:0.2.1-rc.5';
assert(/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(image));
const docker = createDockerApi(defaultDockerSocket());
let id;
const snapshotFile = path.join(root, '.tmp', `video-snapshot-${randomUUID()}.tar`);
async function saveArchive(destination, omitBroken = false) {
  const archive = await docker.getArchive(id, '/workspace/out');
  if (!archive) return;
  await mkdir(destination, { recursive: true });
  await scanArchive(archive, 256 * 1024 ** 2, async (name, _size, stream) => {
    if (omitBroken && ['broken.mp4', 'audio-only.mp4'].includes(name)) return;
    const target = path.resolve(destination, name);
    assert(target.startsWith(destination + path.sep));
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
  });
}
async function exec(command) {
  const job = await docker.exec(id, command);
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  demultiplex(job.stream, stdout, stderr);
  const read = async (stream) => {
    const chunks = [];
    let size = 0;
    for await (const c of stream) {
      size += c.length;
      assert(size < 2 * 1024 * 1024, '检查输出过大');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const timeout = setTimeout(() => job.stream.destroy(new Error('视频验证超时')), 900_000);
  try {
    const [text, errors] = await Promise.all([read(stdout), read(stderr)]);
    assert.equal((await docker.inspectExec(job.id)).ExitCode, 0, errors);
    return text;
  } finally {
    clearTimeout(timeout);
    job.stream.destroy();
  }
}
try {
  const created = await docker.createContainer(`oasis-video-check-${randomUUID()}`, {
    Image: image,
    Entrypoint: ['node', '-e', 'setInterval(()=>{},1000)'],
    Labels: { 'oasis.component': 'video-check' },
    HostConfig: {
      NetworkMode: 'none',
      NanoCpus: 2e9,
      Memory: 2 * 1024 ** 3,
      PidsLimit: 512,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
  });
  id = created.Id;
  await docker.putArchive(
    id,
    '/workspace',
    Readable.from([
      await packFiles([
        {
          path: 'video-project.py',
          content: await readFile(path.join(root, 'services/harness/test/video-project.py')),
        },
      ]),
    ]),
  );
  await docker.startContainer(id);
  console.log(await exec(['python3', '/workspace/video-project.py']));
  await exec([
    'node',
    '-e',
    "require('node:fs').writeFileSync('/workspace/out/broken.mp4','not video')",
  ]);
  await exec([
    'ffmpeg',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'aac',
    '/workspace/out/audio-only.mp4',
  ]);
  const archive = await docker.getArchive(id, '/workspace/out');
  assert(archive);
  // 与生产一样先存下产出包，再交给 inspector 的独立检查容器解码
  await mkdir(path.dirname(snapshotFile), { recursive: true });
  await pipeline(archive, createWriteStream(snapshotFile, { flags: 'wx' }));
  const { report } = await runMediaCheck(
    docker,
    { image, cores: 2, memoryMb: 2048, pidsLimit: 512 },
    createReadStream(snapshotFile),
    { files: 30, timeoutMs: 180_000, durationMs: 1200_000, maxBytes: 256 * 1024 ** 2 },
  );
  for (const name of [
    'landscape/final.mp4',
    'landscape/moved 工程/project.mlt',
    'landscape/moved 工程/subtitles.srt',
    'portrait/final.mp4',
    'portrait/project/project.mlt',
  ])
    assert.equal(
      report.files.find((f) => f.path === name)?.valid,
      true,
      `${name}: ${JSON.stringify(report)}`,
    );
  assert.equal(report.files.find((f) => f.path === 'broken.mp4')?.valid, false);
  assert.equal(report.files.find((f) => f.path === 'audio-only.mp4')?.valid, false);
  assert.deepEqual(await docker.listContainers(MEDIA_LABEL), [], '检查容器应用完即删');
  // 错误样本只在报告中，不作为最终成片交付。
  await saveArchive(output, true);
  await writeFile(path.join(output, 'trusted-media-check.json'), JSON.stringify(report, null, 2));
  console.log(
    'PASS: trusted video/project/subtitle check in a separate container, corrupted MP4 rejected',
  );
  console.log(`最终证据：${output}`);
} catch (error) {
  if (id) {
    const debug = path.join(root, '.tmp', `video-debug-${randomUUID()}`);
    await saveArchive(debug).catch(() => undefined);
    console.error(`失败样本：${debug}`);
  }
  throw error;
} finally {
  if (id) await docker.removeContainer(id);
  await rm(snapshotFile, { force: true });
}
