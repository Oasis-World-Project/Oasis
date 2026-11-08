// 音视频解码检查（ADR 0024）：开什么样的检查容器、放进去哪些文件、报告怎么对回请求、出错和停止时收拾干净。
// Docker 用假的：真容器里的解码由 pnpm media:smoke、video:smoke 和全链路回归覆盖。
import { PassThrough, Readable } from 'node:stream';
import { extractFiles, HttpError, packFiles, type DockerApi } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { MEDIA_LABEL, createMediaCheck } from '../src/service/media-check.ts';
import type { Sources } from '../src/service/sources.ts';

/** 和 harness 存的 outputs.tar 一样：第一层是 out/ */
const outputsTar = (paths: string[]) =>
  packFiles(paths.map((path) => ({ path: `out/${path}`, content: Buffer.from(path) })));

/** Docker 非 TTY 输出的一帧（stdout） */
function frame(payload: string): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(Buffer.byteLength(payload), 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** 受信脚本的报告：放进容器的音视频都算解码成功 */
const allValid = (files: { path: string }[]) =>
  JSON.stringify({
    files: files
      .filter((file) => /\.(mp4|wav|mp3)$/.test(file.path))
      .map((file) => ({ path: file.path, valid: true })),
    unchecked: [],
  });

function fakeDocker(
  options: {
    output?: (files: { path: string }[]) => string;
    exitCode?: number;
    createError?: unknown;
    /** 不自动结束脚本：测试自己调 finish */
    hold?: boolean;
  } = {},
) {
  const created: Record<string, unknown>[] = [];
  const put: { dir: string; paths: string[] }[] = [];
  const execs: string[][] = [];
  const removed: string[] = [];
  const pending: (() => void)[] = [];
  let next = 0;
  const docker = {
    async createContainer(name: string, spec: Record<string, unknown>) {
      if (options.createError) throw options.createError;
      created.push({ name, ...spec });
      return { Id: `box-${++next}` };
    },
    async startContainer() {},
    async putArchive(_id: string, dir: string, tar: Readable) {
      put.push({ dir, paths: (await extractFiles(tar)).map((file) => file.path) });
    },
    async exec(_id: string, cmd: string[]) {
      execs.push(cmd);
      const stream = new PassThrough();
      const files = (put.at(-1)?.paths ?? []).map((path) => ({ path }));
      const finish = () => stream.end(frame((options.output ?? allValid)(files)));
      if (options.hold) pending.push(finish);
      else finish();
      return { id: `exec-${execs.length}`, stream };
    },
    async inspectExec() {
      return { ExitCode: options.exitCode ?? 0 };
    },
    async removeContainer(id: string) {
      removed.push(id);
    },
  } as unknown as DockerApi;
  return { docker, created, put, execs, removed, pending };
}

function checkerWith(docker: DockerApi, tar: Promise<Buffer>, concurrency = 2) {
  const opened: Readable[] = [];
  const sources = {
    async open() {
      const stream = Readable.from([await tar]);
      opened.push(stream);
      return stream;
    },
  } as unknown as Sources;
  const check = createMediaCheck({
    sources,
    docker,
    box: { image: 'oasis/harness-sandbox-base:test', memoryMb: 512, pidsLimit: 64 },
    limits: { files: 20, durationMs: 60_000, maxBytes: 1024 * 1024 },
    concurrency,
    sourceTimeoutMs: 1000,
  });
  return { check, opened };
}

const body = (paths: string[], cores = 1.5) => ({
  source: { url: 'http://127.0.0.1:8333/oasis-harness/runs/r/outputs.tar?sig' },
  paths,
  cores,
  timeoutMs: 5000,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('音视频解码检查', () => {
  it('不联网、按调用方给的核数开容器；只放进请求的音视频和工程素材；报告对回请求，用完即删', async () => {
    const fake = fakeDocker();
    const tar = outputsTar(['clip/a.mp4', 'b.wav', 'notes.md', 'cover.png', 'other.mp3']);
    const { check } = checkerWith(fake.docker, tar);
    const result = await check(body(['clip/a.mp4', 'b.wav', 'gone.mp4']));

    expect(fake.created[0]).toMatchObject({
      Image: 'oasis/harness-sandbox-base:test',
      Labels: { 'oasis.component': 'inspector-media' },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'none',
        NanoCpus: 1.5e9,
        Memory: 512 * 1024 * 1024,
        PidsLimit: 64,
        CapDrop: ['ALL'],
      },
    });
    expect(MEDIA_LABEL).toBe('oasis.component=inspector-media');
    // 没请求的音视频、和解码无关的文件不进检查容器；工程可能引用的图片要放进去
    expect(fake.put).toEqual([{ dir: '/tmp', paths: ['b.wav', 'clip/a.mp4', 'cover.png'] }]);
    const cmd = fake.execs[0]!;
    expect(cmd.slice(0, 3)).toEqual(['node', '--input-type=module', '-e']);
    expect(cmd[4]).toBe('/tmp/oasis-media');
    expect(JSON.parse(cmd[5]!)).toEqual({ files: 20, timeoutMs: 5000, durationMs: 60_000 });

    expect(result.files.map((file) => file.path).sort()).toEqual(['b.wav', 'clip/a.mp4']);
    expect(result.unchecked).toEqual(['gone.mp4']);
    expect(result.usage.cores).toBe(1.5);
    expect(result.usage.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fake.removed).toEqual(['box-1']);
  });

  it('镜像没建、Docker 连不上：说清原因（503），下载的产出包也关掉', async () => {
    const missing = fakeDocker({
      createError: Object.assign(new Error('No such image'), { status: 404 }),
    });
    const first = checkerWith(missing.docker, outputsTar(['a.mp4']));
    await expect(first.check(body(['a.mp4']))).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('pnpm sandbox:build'),
    });
    expect(first.opened[0]?.destroyed).toBe(true);

    const offline = fakeDocker({ createError: new Error('connect ENOENT') });
    await expect(
      checkerWith(offline.docker, outputsTar(['a.mp4'])).check(body(['a.mp4'])),
    ).rejects.toMatchObject({ statusCode: 503, message: '媒体检查用不了：连不上 Docker' });
  });

  it.each([
    ['脚本没正常结束', { exitCode: 1 }, '媒体检查进程失败'],
    ['报告不合格式', { output: () => '{"files":"?"}' }, '媒体检查报告格式不对'],
  ])('%s：报错，不冒充通过；容器照样删掉', async (_name, options, message) => {
    const fake = fakeDocker(options);
    await expect(
      checkerWith(fake.docker, outputsTar(['a.mp4'])).check(body(['a.mp4'])),
    ).rejects.toThrow(message);
    expect(fake.removed).toEqual(['box-1']);
  });

  it('调用方断开（用户停止节点）：停下脚本、删掉容器', async () => {
    const fake = fakeDocker({ hold: true });
    const abort = new AbortController();
    const running = checkerWith(fake.docker, outputsTar(['a.mp4'])).check(
      body(['a.mp4']),
      abort.signal,
    );
    while (!fake.execs.length) await tick();
    abort.abort();
    await expect(running).rejects.toBeInstanceOf(HttpError);
    expect(fake.removed).toEqual(['box-1']);
  });

  it('同时开的检查容器有上限：多出来的排队，排队时断开的不占位置', async () => {
    const fake = fakeDocker({ hold: true });
    const { check } = checkerWith(fake.docker, outputsTar(['a.mp4']), 1);
    const first = check(body(['a.mp4']));
    while (!fake.execs.length) await tick();
    const leaving = new AbortController();
    const gaveUp = check(body(['a.mp4']), leaving.signal);
    const second = check(body(['a.mp4']));
    await tick();
    expect(fake.created).toHaveLength(1);
    leaving.abort();
    await expect(gaveUp).rejects.toThrow();
    fake.pending.shift()!();
    await first;
    while (fake.execs.length < 2) await tick();
    expect(fake.created).toHaveLength(2);
    fake.pending.shift()!();
    expect((await second).files).toHaveLength(1);
  });
});
