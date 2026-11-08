// 音视频、平台工程（.mlt）、字幕的解码检查（ADR 0024；原来在 harness 存产出时借沙箱做）。
// 每次检查开一个不联网、限核限内存的独立容器（沙箱基础镜像，自带 ffmpeg 和 oasis-media），把要查的文件
// 以只读方式放进去，跑受信脚本 media/media-check.mjs，用完即删。核数和时限由付费的调用方定，
// 实际用时报回去由它结算；排队和下载的时间不算。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import {
  MEDIA_FILE,
  MediaCheckReport,
  type MediaCheckBody,
  type MediaCheckResult,
} from '@oasis/contracts/inspector';
import { demultiplex, HttpError, rewriteArchive, type DockerApi } from '@oasis/service-kit';
import type { Sources } from './sources.ts';

/** 检查容器：镜像和资源 */
export interface MediaBox {
  image: string;
  cores: number;
  memoryMb: number;
  pidsLimit: number;
}

/** 受信脚本的上限：最多查几个文件、总时限、单个媒体最长多久；放进容器的字节数 */
export interface MediaLimits {
  files: number;
  timeoutMs: number;
  durationMs: number;
  maxBytes?: number;
}

/** 平台工程引用的素材也放进去（工程检查要核对引用）；别的文件不进检查容器 */
const PROJECT_SOURCE = /\.(json|png|jpe?g|webp)$/i;
const ROOT = 'oasis-media';
const REPORT_MAX_BYTES = 2 * 1024 * 1024;
const COMPONENT = 'inspector-media';
/** 检查容器上的标记：认得出是 inspector 开的（验收脚本据此确认用完即删） */
export const MEDIA_LABEL = `oasis.component=${COMPONENT}`;

let script: string | undefined;
const scriptOf = () =>
  (script ??= readFileSync(new URL('../../media/media-check.mjs', import.meta.url), 'utf8'));

/** 开不出检查容器：说清是镜像没建还是 Docker 连不上 */
function unavailable(err: unknown, image: string): HttpError {
  const status = (err as { status?: unknown } | undefined)?.status;
  return new HttpError(
    503,
    'media_check_unavailable',
    status === 404
      ? `媒体检查镜像 ${image} 不存在，请先构建（pnpm sandbox:build）`
      : typeof status === 'number'
        ? '媒体检查容器开不出来'
        : '媒体检查用不了：连不上 Docker',
  );
}

/** 在检查容器里跑受信脚本，读回报告；超时、被停止时断开（容器随后删掉） */
async function execReport(
  docker: DockerApi,
  id: string,
  limits: MediaLimits,
  signal?: AbortSignal,
): Promise<Buffer> {
  const execution = await docker.exec(id, [
    'node',
    '--input-type=module',
    '-e',
    scriptOf(),
    `/tmp/${ROOT}`,
    JSON.stringify({
      files: limits.files,
      timeoutMs: limits.timeoutMs,
      durationMs: limits.durationMs,
    }),
  ]);
  const output = new PassThrough();
  // 标准错误不用（报告只看标准输出）；超时、断开时它也带着同一个错误结束，不能没人接
  const errors = new PassThrough();
  errors.on('error', () => undefined).resume();
  demultiplex(execution.stream, output, errors);
  const stop = (reason: Error) => execution.stream.destroy(reason);
  // 脚本自己按时限收尾；多留 10 秒给它写报告
  const timer = setTimeout(
    () => stop(new HttpError(500, 'media_check_timeout', '媒体检查超时')),
    limits.timeoutMs + 10_000,
  );
  const onAbort = () => stop(new HttpError(499, 'check_aborted', '检查已被停止'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of output) {
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (size > REPORT_MAX_BYTES)
        throw new HttpError(500, 'media_check_failed', '媒体检查报告过大');
      chunks.push(chunk);
    }
    if ((await docker.inspectExec(execution.id)).ExitCode !== 0)
      throw new HttpError(500, 'media_check_failed', '媒体检查进程失败');
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    execution.stream.destroy();
  }
}

/**
 * 开一个检查容器解码产出包里的音视频：snapshot 是 Docker 取出的目录归档（第一层是目录名，
 * 和 harness 存的 outputs.tar 一样）。默认放进所有音视频和工程素材，keep 可以只挑一部分。
 * 容器只活 lifetimeMs：调用方意外退出时它自己结束、被 Docker 自动删掉，不留孤儿。
 */
export async function runMediaCheck(
  docker: DockerApi,
  box: MediaBox,
  snapshot: Readable,
  limits: MediaLimits,
  options: { keep?: (path: string) => boolean; lifetimeMs?: number; signal?: AbortSignal } = {},
): Promise<{ report: MediaCheckReport; elapsedMs: number }> {
  const keep =
    options.keep ?? ((path: string) => MEDIA_FILE.test(path) || PROJECT_SOURCE.test(path));
  const lifetimeMs = Math.round(options.lifetimeMs ?? limits.timeoutMs + 10 * 60_000);
  let id: string;
  try {
    ({ Id: id } = await docker.createContainer(`oasis-media-${randomUUID()}`, {
      Image: box.image,
      Entrypoint: ['node', '-e', `setTimeout(() => {}, ${lifetimeMs})`],
      Labels: { 'oasis.component': COMPONENT },
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'none',
        NanoCpus: Math.round(box.cores * 1e9),
        Memory: box.memoryMb * 1024 * 1024,
        PidsLimit: box.pidsLimit,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    }));
  } catch (err) {
    snapshot.destroy();
    throw unavailable(err, box.image);
  }
  try {
    await docker.startContainer(id);
    // root 所有、检查用户只读：脚本只读这些字节，改不了
    await docker.putArchive(
      id,
      '/tmp',
      rewriteArchive(snapshot, ROOT, keep, limits.maxBytes, true),
    );
    options.signal?.throwIfAborted();
    const started = Date.now();
    const output = await execReport(docker, id, limits, options.signal);
    const elapsedMs = Date.now() - started;
    let report: MediaCheckReport;
    try {
      report = MediaCheckReport.parse(JSON.parse(output.toString('utf8')));
    } catch {
      throw new HttpError(500, 'media_check_failed', '媒体检查报告格式不对');
    }
    return { report, elapsedMs };
  } finally {
    snapshot.destroy();
    await docker.removeContainer(id).catch(() => undefined);
  }
}

/** 同时最多开几个检查容器；多出来的排队（排队时间不计费），调用方断开就不再等 */
function createQueue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    while (active >= limit) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          resolve();
        };
        waiting.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    signal?.throwIfAborted();
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** 关卡的解码检查：读运行产出包里请求的这些文件（加上工程引用的素材），报回结果和实际算力 */
export function createMediaCheck(deps: {
  sources: Sources;
  docker: DockerApi;
  box: Omit<MediaBox, 'cores'>;
  limits: Omit<MediaLimits, 'timeoutMs'>;
  concurrency: number;
  /** 下载产出包最多等多久：检查容器的寿命要把它算进去 */
  sourceTimeoutMs: number;
}) {
  const queue = createQueue(deps.concurrency);
  return (body: MediaCheckBody, signal?: AbortSignal): Promise<MediaCheckResult> =>
    queue(async () => {
      const wanted = new Set(body.paths);
      const { report, elapsedMs } = await runMediaCheck(
        deps.docker,
        { ...deps.box, cores: body.cores },
        await deps.sources.open(body.source.url, signal),
        { ...deps.limits, timeoutMs: body.timeoutMs },
        {
          keep: (path) => wanted.has(path) || PROJECT_SOURCE.test(path),
          lifetimeMs: deps.sourceTimeoutMs + body.timeoutMs + 60_000,
          ...(signal ? { signal } : {}),
        },
      );
      const files = report.files.filter((file) => wanted.has(file.path));
      return {
        files,
        unchecked: body.paths.filter((path) => !files.some((file) => file.path === path)),
        usage: { cores: body.cores, elapsedMs },
      };
    }, signal);
}
