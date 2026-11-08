// 执行器：为一次运行起一个隔离的沙箱，给出它的 stdin/stdout，并能拷文件进出、销毁。
// 现在只有 Docker 实现；上云后加 K8s Job、云 GPU 等实现，接口不变（ADR 0003 §6）。
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { demultiplex, type DockerApi } from '@oasis/service-kit';
import { ExecutionEnvironment } from '@oasis/contracts/harness';

export interface SandboxSpec {
  runId: string;
  /** 这个会话的持久工作目录（工作区和 dsh 会话）；同一会话的后续运行共用，不挂载宿主机目录。 */
  workspaceId: string;
  /** 接着原会话或接管：持久工作目录必须已经在，不能新建空目录冒充恢复 */
  restore?: boolean;
  /** 不跑镜像默认的 dsh，改跑这个命令（工具运行的步骤执行器，ADR 0025） */
  command?: string[];
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
}

export interface Executor {
  /** 就绪检查：执行环境可用、镜像和网络都在 */
  check(): Promise<void>;
  start(spec: SandboxSpec): Promise<Sandbox>;
  /** 清理不在 keep 里的沙箱（harness 重启后遗留的），返回清理了几个 */
  removeOrphans(keep: ReadonlySet<string>): Promise<number>;
  /** 接管前停止旧进程，避免两份执行同时写同一目录。返回实际停止时间。 */
  suspend?(runId: string): Promise<{ endedAt: Date; cores?: number } | undefined>;
  /** 会话的持久工作目录还在（接着原会话做的唯一依据） */
  workspaceExists(sessionId: string): Promise<boolean>;
  purgeWorkspace(sessionId: string): Promise<void>;
  environment?(): Promise<ExecutionEnvironment>;
  readStoredArchive?(runId: string, path: string): Promise<Readable | undefined>;
}

/** 工具运行的步骤执行器在镜像里的位置；探测到它，执行环境才有 tool-steps 能力（ADR 0025） */
export const STEPS_RUNNER = '/opt/oasis/services/harness/sandbox/oasis-steps.ts';
/** 工具运行要的执行环境能力：旧镜像没有步骤执行器时准入就拒绝，不起沙箱 */
export const TOOL_STEPS_CAPABILITY = 'tool-steps';

const LABEL_COMPONENT = 'oasis.component=harness-sandbox';
const LABEL_RUN = 'oasis.run-id';
const volumeNames = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('工作目录身份不合法');
  return [`oasis-workspace-${id}`, `oasis-sessions-${id}`];
};

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
}): Executor {
  const { docker } = deps;
  const instanceId = randomUUID();
  let detected: { imageId: string; value: Promise<ExecutionEnvironment> } | undefined;
  async function probe(imageId: string): Promise<ExecutionEnvironment> {
    const script = `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const software={};for(const [key,bin,args] of [['node','node',['--version']],['python','python3',['--version']],['blender','blender',['--version']],['ffmpeg','ffmpeg',['-version']],['libreoffice','libreoffice',['--version']],['pdf','pdftoppm',['-v']]]){const r=spawnSync(bin,args,{encoding:'utf8',timeout:15000});if(r.status===0)software[key]=(r.stdout||r.stderr).split('\\n')[0]}if(fs.existsSync('${STEPS_RUNNER}'))software['${TOOL_STEPS_CAPABILITY}']='oasis-steps';process.stdout.write(JSON.stringify({software,capabilities:Object.keys(software),notes:['沙箱仅经代理访问模型、工具和获准的软件包源。','本地没有浏览器；可运行应用应交齐 oasis-app.json 与配套文件，交付前用 oasis-tool app.check --dir out/<应用目录> 在独立浏览器里自查（交付后关卡复跑同一套检查）；外站测试只使用目录中可用的 website.test。','项目依赖应装入 /workspace，例如项目 node_modules 或 .venv，才能随工作目录恢复。']}))`;
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
      for (const [index, name] of volumeNames(spec.workspaceId).entries()) {
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
      for (const previous of await docker.listContainers(LABEL_COMPONENT)) {
        if (previous.Labels[LABEL_RUN] !== spec.runId) continue;
        const { State } = await docker.inspectContainer(previous.Id);
        if (State.Running) throw new Error('原运行沙箱尚未停止，不能并发接管');
        await docker.removeContainer(previous.Id);
      }
      const { Id: id } = await docker.createContainer(`oasis-run-${spec.runId}`, {
        Image: deps.image,
        ...(spec.command ? { Entrypoint: spec.command } : {}),
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
          destroy,
        };
      } catch (err) {
        await destroy().catch(() => undefined);
        throw err;
      }
    },

    async suspend(runId) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      const targets = containers.filter((c) => c.Labels[LABEL_RUN] === runId);
      if (targets.length === 0) return undefined;
      let ended = new Date();
      let cores: number | undefined;
      for (const container of targets) {
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
