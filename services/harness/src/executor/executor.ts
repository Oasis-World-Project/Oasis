// 执行器：为一次运行起一个隔离的沙箱，给出它的 stdin/stdout，并能拷文件进出、销毁。
// 现在只有 Docker 实现；上云后加 K8s Job、云 GPU 等实现，接口不变（ADR 0003 §6）。
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rewriteArchive } from './tar.ts';
import type { DockerApi } from './docker-api.ts';

export interface SandboxSpec {
  runId: string;
  /** 沙箱里的环境变量（含临时 Key，不得写进日志） */
  env: Record<string, string>;
  /** 启动前解到沙箱里的文件：目录 → tar 包 */
  files: { dir: string; tar: Buffer | Readable }[];
}

export interface Sandbox {
  /** 停止归档前冻结进程，避免归档期间仍产生新的外部调用。 */
  pause(): Promise<void>;
  readonly id: string;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** 把沙箱里某个路径打成 tar 流取出；路径不存在时返回 undefined */
  readArchive(path: string): Promise<Readable | undefined>;
  /** 销毁沙箱（运行中也立即结束）；可重复调用 */
  destroy(): Promise<void>;
  inspectAudio?(snapshot: Readable): Promise<unknown>;
}

export interface Executor {
  /** 就绪检查：执行环境可用、镜像和网络都在 */
  check(): Promise<void>;
  start(spec: SandboxSpec): Promise<Sandbox>;
  /** 清理不在 keep 里的沙箱（harness 重启后遗留的），返回清理了几个 */
  removeOrphans(keep: ReadonlySet<string>): Promise<number>;
}

const LABEL_COMPONENT = 'oasis.component=harness-sandbox';
const LABEL_RUN = 'oasis.run-id';

/**
 * Docker 在非 TTY 模式下把 stdout/stderr 复用在同一条连接上：
 * 每帧 8 字节头（第 1 字节是流编号 1=stdout 2=stderr，后 4 字节是长度，大端）+ 内容。
 */
export function demultiplex(source: Readable, stdout: PassThrough, stderr: PassThrough): void {
  let pending = Buffer.alloc(0);
  source.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const payload = pending.subarray(8, 8 + size);
      (pending[0] === 2 ? stderr : stdout).write(payload);
      pending = pending.subarray(8 + size);
    }
  });
  source.on('end', () => {
    stdout.end();
    stderr.end();
  });
  source.on('error', (err) => {
    stdout.destroy(err);
    stderr.destroy(err);
  });
}

interface AudioInspectionLimits {
  files: number;
  timeoutMs: number;
  durationMs: number;
  maxBytes: number;
}
export async function inspectSandboxAudio(
  docker: DockerApi,
  id: string,
  snapshot: Readable,
  limits: AudioInspectionLimits,
): Promise<unknown> {
  const prefix = `oasis-audio-${randomUUID()}`;
  // 从已保存快照复制到 root 所有、node 只读的目录；应用不能改动本次检查的字节。
  await docker.putArchive(
    id,
    '/tmp',
    rewriteArchive(
      snapshot,
      prefix,
      (path) => /\.(wav|mp3|m4a|flac|ogg|webm|aac)$/i.test(path),
      limits.maxBytes,
      true,
    ),
  );
  const script = readFileSync(new URL('../../media/audio-check.mjs', import.meta.url), 'utf8');
  const execution = await docker.exec(id, [
    'node',
    '--input-type=module',
    '-e',
    script,
    `/tmp/${prefix}`,
    JSON.stringify(limits),
  ]);
  const output = new PassThrough();
  const errors = new PassThrough();
  errors.resume();
  demultiplex(execution.stream, output, errors);
  const timeout = setTimeout(
    () => execution.stream.destroy(new Error('音频检查超时')),
    limits.timeoutMs + 10_000,
  );
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of output) {
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('音频检查报告过大');
      chunks.push(chunk);
    }
    const state = await docker.inspectExec(execution.id);
    if (state.ExitCode !== 0) throw new Error('音频检查进程失败');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    clearTimeout(timeout);
    execution.stream.destroy();
  }
}

export function createDockerExecutor(deps: {
  docker: DockerApi;
  image: string;
  network: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** 沙箱里的工作目录，启动前确保 files 里的目录都在它下面 */
  workdir: string;
  mediaCheck?: { files: number; timeoutMs: number; durationMs: number; maxBytes: number };
}): Executor {
  const { docker } = deps;
  return {
    async check() {
      await docker.ping();
      if (!(await docker.imageExists(deps.image))) {
        throw new Error(
          `沙箱镜像 ${deps.image} 不存在，请先构建（见 infra/images/harness-sandbox-base）`,
        );
      }
      if (!(await docker.networkExists(deps.network))) {
        throw new Error(`沙箱网络 ${deps.network} 不存在，请先 pnpm infra:up`);
      }
    },

    async start(spec) {
      const { Id: id } = await docker.createContainer(`oasis-run-${spec.runId}`, {
        Image: deps.image,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Labels: { 'oasis.component': 'harness-sandbox', [LABEL_RUN]: spec.runId },
        WorkingDir: deps.workdir,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        HostConfig: {
          NetworkMode: deps.network,
          NanoCpus: Math.round(deps.cpus * 1e9),
          Memory: deps.memoryMb * 1024 * 1024,
          PidsLimit: deps.pidsLimit,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
        },
      });
      let destroyed: Promise<void> | undefined;
      const destroy = () => (destroyed ??= docker.removeContainer(id));
      try {
        for (const file of spec.files) await docker.putArchive(id, file.dir, file.tar);
        const connection = await docker.attach(id);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        demultiplex(connection, stdout, stderr);
        await docker.startContainer(id);
        return {
          id,
          stdin: connection,
          stdout,
          stderr,
          readArchive: (path) => docker.getArchive(id, path),
          pause: () => docker.pauseContainer(id),
          ...(deps.mediaCheck
            ? {
                inspectAudio: (snapshot: Readable) =>
                  inspectSandboxAudio(docker, id, snapshot, deps.mediaCheck!),
              }
            : {}),
          destroy,
        };
      } catch (err) {
        await destroy().catch(() => undefined);
        throw err;
      }
    },

    async removeOrphans(keep) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      const orphans = containers.filter((c) => !keep.has(c.Labels[LABEL_RUN] ?? ''));
      for (const container of orphans) await docker.removeContainer(container.Id);
      return orphans.length;
    },
  };
}
