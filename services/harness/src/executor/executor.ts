// 执行器：为一次运行起一个隔离的沙箱，给出它的 stdin/stdout，并能拷文件进出、销毁。
// 现在只有 Docker 实现；上云后加 K8s Job、云 GPU 等实现，接口不变（ADR 0003 §6）。
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rewriteArchive } from './tar.ts';
import type { DockerApi } from './docker-api.ts';
import { ExecutionEnvironment } from '@oasis/contracts/harness';

export interface SandboxSpec {
  runId: string;
  /** 同一原生会话的后续运行共用工作目录；不挂载宿主机目录。 */
  workspaceId?: string;
  restore?: boolean;
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
  inspectMedia?(snapshot: Readable): Promise<unknown>;
}

export interface Executor {
  /** 就绪检查：执行环境可用、镜像和网络都在 */
  check(): Promise<void>;
  start(spec: SandboxSpec): Promise<Sandbox>;
  /** 清理不在 keep 里的沙箱（harness 重启后遗留的），返回清理了几个 */
  removeOrphans(keep: ReadonlySet<string>): Promise<number>;
  /** 接管前停止旧进程，避免两份执行同时写同一目录。返回实际停止时间。 */
  suspend?(runId: string): Promise<{ endedAt: Date; cores?: number }>;
  workspaceExists?(sessionId: string): Promise<boolean>;
  purgeWorkspace?(sessionId: string): Promise<void>;
  environment?(): Promise<ExecutionEnvironment>;
  readStoredArchive?(runId: string, path: string): Promise<Readable | undefined>;
}

const LABEL_COMPONENT = 'oasis.component=harness-sandbox';
const LABEL_RUN = 'oasis.run-id';
const volumeNames = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('工作目录身份不合法');
  return [`oasis-workspace-${id}`, `oasis-sessions-${id}`];
};

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

interface MediaInspectionLimits {
  files: number;
  timeoutMs: number;
  durationMs: number;
  maxBytes?: number;
}
export async function inspectSandboxMedia(
  docker: DockerApi,
  id: string,
  snapshot: Readable,
  limits: MediaInspectionLimits,
): Promise<unknown> {
  const prefix = `oasis-media-${randomUUID()}`;
  // 从已保存快照复制到 root 所有、node 只读的目录；应用不能改动本次检查的字节。
  await docker.putArchive(
    id,
    '/tmp',
    rewriteArchive(
      snapshot,
      prefix,
      (path) =>
        /\.(wav|mp3|m4a|flac|ogg|webm|aac|mp4|mov|mkv|avi|mlt|json|srt|png|jpe?g|webp)$/i.test(
          path,
        ),
      limits.maxBytes,
      true,
    ),
  );
  const script = readFileSync(new URL('../../media/media-check.mjs', import.meta.url), 'utf8');
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
    () => execution.stream.destroy(new Error('媒体检查超时')),
    limits.timeoutMs + 10_000,
  );
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of output) {
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('媒体检查报告过大');
      chunks.push(chunk);
    }
    const state = await docker.inspectExec(execution.id);
    if (state.ExitCode !== 0) throw new Error('媒体检查进程失败');
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
  sessionsDir?: string;
  mediaCheck?: { files: number; timeoutMs: number; durationMs: number; maxBytes?: number };
}): Executor {
  const { docker } = deps;
  const instanceId = randomUUID();
  let detected: { imageId: string; value: Promise<ExecutionEnvironment> } | undefined;
  async function probe(imageId: string): Promise<ExecutionEnvironment> {
    const script = `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const software={};for(const [key,bin,args] of [['node','node',['--version']],['python','python3',['--version']],['blender','blender',['--version']],['ffmpeg','ffmpeg',['-version']],['libreoffice','libreoffice',['--version']],['pdf','pdftoppm',['-v']]]){const r=spawnSync(bin,args,{encoding:'utf8',timeout:15000});if(r.status===0)software[key]=(r.stdout||r.stderr).split('\\n')[0]}process.stdout.write(JSON.stringify({software,capabilities:Object.keys(software),notes:['沙箱仅经代理访问模型、工具和获准的软件包源。','本地没有浏览器；可运行应用应交齐 oasis-app.json 与配套文件，由独立预览执行器在节点关卡运行实际浏览器检查；外站测试只使用目录中可用的 website.test。','项目依赖应装入 /workspace，例如项目 node_modules 或 .venv，才能随工作目录恢复。']}))`;
    const { Id: id } = await docker.createContainer(`oasis-probe-${randomUUID()}`, {
      Image: imageId,
      Entrypoint: ['node'],
      Cmd: ['-e', script],
      Labels: { 'oasis.component': 'harness-probe', 'oasis.instance-id': instanceId },
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'none',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: deps.memoryMb * 1024 * 1024,
        PidsLimit: deps.pidsLimit,
      },
    });
    try {
      const stream = await docker.attach(id);
      const output = new PassThrough();
      const errors = new PassThrough();
      errors.resume();
      demultiplex(stream, output, errors);
      const reading = output.toArray();
      await docker.startContainer(id);
      const chunks = await reading;
      return ExecutionEnvironment.parse({
        image: deps.image,
        imageId,
        ...JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
    } finally {
      await docker.removeContainer(id);
    }
  }
  return {
    async environment() {
      await this.check();
      const imageId = await docker.imageId(deps.image);
      if (detected?.imageId !== imageId) {
        const value = probe(imageId);
        detected = { imageId, value };
        void value.catch(() => {
          if (detected?.value === value) detected = undefined;
        });
      }
      return detected.value;
    },
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
      const mounts: { Type: string; Source: string; Target: string }[] = [];
      if (spec.workspaceId) {
        const names = volumeNames(spec.workspaceId);
        for (const [index, name] of names.entries()) {
          const volume = await docker.volume(name);
          if (volume && volume.Labels?.['oasis.session-id'] !== spec.workspaceId)
            throw new Error('持久工作目录归属不匹配');
          if (!volume) {
            if (spec.restore) throw new Error('原运行持久工作目录缺失，不能从空目录恢复');
            await docker.createVolume(name, {
              'oasis.component': 'harness-workspace',
              'oasis.session-id': spec.workspaceId,
            });
          }
          if (index && !deps.sessionsDir) throw new Error('持久会话目录未配置');
          mounts.push({
            Type: 'volume',
            Source: name,
            Target: index === 0 ? deps.workdir : deps.sessionsDir!,
          });
        }
      }
      for (const previous of await docker.listContainers(LABEL_COMPONENT)) {
        if (previous.Labels[LABEL_RUN] !== spec.runId) continue;
        const { State } = await docker.inspectContainer(previous.Id);
        if (State.Running) throw new Error('原运行沙箱尚未停止，不能并发接管');
        await docker.removeContainer(previous.Id);
      }
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
          Mounts: mounts,
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
        if (spec.restore && deps.sessionsDir) {
          const cleanup = await docker.exec(id, [
            'node',
            '-e',
            `const fs=require('node:fs');function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())walk(f);else if(e.isFile()&&e.name.endsWith('.lock'))fs.unlinkSync(f)}}walk(process.argv[1])`,
            deps.sessionsDir,
          ]);
          cleanup.stream.resume();
          await new Promise<void>((resolve, reject) => {
            cleanup.stream.once('end', resolve);
            cleanup.stream.once('error', reject);
          });
          if ((await docker.inspectExec(cleanup.id)).ExitCode !== 0)
            throw new Error('恢复会话锁清理失败');
        }
        return {
          id,
          stdin: connection,
          stdout,
          stderr,
          readArchive: (path) => docker.getArchive(id, path),
          pause: () => docker.pauseContainer(id),
          ...(deps.mediaCheck
            ? {
                inspectMedia: (snapshot: Readable) =>
                  inspectSandboxMedia(docker, id, snapshot, deps.mediaCheck!),
              }
            : {}),
          destroy,
        };
      } catch (err) {
        await destroy().catch(() => undefined);
        throw err;
      }
    },

    async suspend(runId) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      let ended = new Date();
      let cores: number | undefined;
      for (const container of containers.filter((c) => c.Labels[LABEL_RUN] === runId)) {
        await docker.stopContainer(container.Id);
        const { State, HostConfig } = await docker.inspectContainer(container.Id);
        if (HostConfig.NanoCpus) cores = HostConfig.NanoCpus / 1e9;
        const stoppedAt = new Date(State.FinishedAt);
        if (Number.isFinite(stoppedAt.getTime()) && stoppedAt.getFullYear() >= 1970)
          ended = stoppedAt;
      }
      return { endedAt: ended, ...(cores ? { cores } : {}) };
    },
    async readStoredArchive(runId, path) {
      const box = (await docker.listContainers(LABEL_COMPONENT)).find(
        (c) => c.Labels[LABEL_RUN] === runId,
      );
      return box ? docker.getArchive(box.Id, path) : undefined;
    },
    async workspaceExists(sessionId) {
      const volumes = await Promise.all(volumeNames(sessionId).map((name) => docker.volume(name)));
      return volumes.every((v) => v?.Labels?.['oasis.session-id'] === sessionId);
    },
    async purgeWorkspace(sessionId) {
      for (const name of volumeNames(sessionId)) {
        const volume = await docker.volume(name);
        if (volume?.Labels?.['oasis.session-id'] === sessionId) await docker.removeVolume(name);
      }
    },

    async removeOrphans(keep) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      const orphans = containers.filter((c) => !keep.has(c.Labels[LABEL_RUN] ?? ''));
      const probes = await docker.listContainers('oasis.component=harness-probe');
      orphans.push(...probes.filter((c) => c.Labels['oasis.instance-id'] !== instanceId));
      for (const container of orphans) await docker.removeContainer(container.Id);
      return orphans.length;
    },
  };
}
