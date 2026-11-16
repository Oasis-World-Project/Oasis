// 执行器：为一次运行起一个隔离的沙箱，给出它的 stdin/stdout，并能拷文件进出、销毁。
// 两种实现：云端的 Docker（这里），用户自己的电脑（device.ts，桌面版连着 Oasis）；接口一样。
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
  /** 沙箱里的环境变量（含临时 Key，不得写进日志） */
  env: Record<string, string>;
  /** 启动前解到沙箱里的文件：目录 → tar 包 */
  files: { dir: string; tar: Buffer | Readable }[];
  /** 准备中的进展（如用户电脑上第一次装 dsh），记进这一轮的进度 */
  notify?: (status: string) => void;
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
  /** 在沙箱里跑一条命令（沙箱要在运行，没暂停）并等它结束；退出码不是 0 就报错 */
  exec(cmd: string[]): Promise<void>;
  /** 运行中往沙箱的某个目录里再解一包文件（群里别的 AI 刚交的群文件）；用户电脑上的沙箱没有 */
  put?(dir: string, tar: Buffer | Readable): Promise<void>;
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
    const script = `const {spawnSync}=require('node:child_process');const fs=require('node:fs');const software={};for(const [key,bin,args] of [['node','node',['--version']],['python','python3',['--version']],['blender','blender',['--version']],['ffmpeg','ffmpeg',['-version']],['libreoffice','libreoffice',['--version']],['pdf','pdftoppm',['-v']],['browser','chromium',['--version']],['git','git',['--version']],['pandoc','pandoc',['--version']],['sqlite','sqlite3',['--version']],['jq','jq',['--version']],['imagemagick','magick',['-version']],['sox','sox',['--version']],['ripgrep','rg',['--version']],['esbuild','esbuild',['--version']],['typescript','tsc',['--version']]]){const r=spawnSync(bin,args,{encoding:'utf8',timeout:15000});if(r.status===0)software[key]=(r.stdout||r.stderr).split('\\n')[0]}const pixelFont=['/usr/share/fonts/opentype/unifont/unifont.otf','/usr/share/fonts/truetype/unifont/unifont.ttf'].find(p=>fs.existsSync(p));process.stdout.write(JSON.stringify({software,capabilities:Object.keys(software),notes:['沙箱仅经代理访问模型、工具和获准的软件包源。',software.browser?'沙箱里有 Chromium（命令 chromium，没有显卡，3D 画面靠 CPU 画）和 playwright-core（chromium.launch() 直接可用），可以打开自己做的页面操作、读页面状态、截图；沙箱不通外网，打不开外站。':'沙箱里没有浏览器。',...(pixelFont?['预装的字体在 /usr/share/fonts 下，可以拷进成果或取子集后内嵌：Noto CJK（中日韩）、点阵像素字体 Unifont（16×16，含中文，'+pixelFont+'）。']:[]),'可运行应用应交齐 oasis-app.json 与配套文件；oasis-tool app.check --dir out/<应用目录> 按画布的方式打开它跑一遍；外站测试只使用目录中可用的 website.test。','项目依赖应装入 /workspace，例如项目 node_modules 或 .venv，才能随工作目录恢复。']}))`;
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
      /** 跑一条命令并等它结束（输出丢掉）；退出码不是 0 就报错 */
      const exec = async (cmd: string[]) => {
        const started = await docker.exec(id, cmd);
        started.stream.resume();
        await new Promise<void>((resolve, reject) => {
          started.stream.once('end', resolve);
          started.stream.once('error', reject);
        });
        const code = (await docker.inspectExec(started.id)).ExitCode;
        if (code !== 0) throw new Error(`沙箱里的命令没成功（退出码 ${code}）`);
      };
      try {
        for (const file of spec.files) await docker.putArchive(id, file.dir, file.tar);
        const connection = await docker.attach(id);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        demultiplex(connection, stdout, stderr);
        await docker.startContainer(id);
        if (spec.restore && deps.sessionsDir)
          await exec([
            'node',
            '-e',
            `const fs=require('node:fs');function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory())walk(f);else if(e.isFile()&&e.name.endsWith('.lock'))fs.unlinkSync(f)}}walk(process.argv[1])`,
            deps.sessionsDir,
          ]).catch((cause: unknown) => {
            throw new Error('恢复会话锁清理失败', { cause });
          });
        return {
          id,
          stdin: connection,
          stdout,
          stderr,
          exec,
          put: (dir, tar) => docker.putArchive(id, dir, tar),
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
