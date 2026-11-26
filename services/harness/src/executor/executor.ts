// 执行器：为一份会话起一个隔离的沙箱（里面跑 dsh），给出它的 stdin/stdout，并能拷文件进出、销毁。
// 沙箱由起它的那一轮起，之后同一份会话的几轮接着用（run/hosts.ts），空闲够久才销毁。
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
  /** 谁的缓存卷（付钱的人）：下载下来的包和工具链，他的每个沙箱都挂上；用户电脑上的沙箱没有 */
  cacheId?: string;
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
  /** 同上，但不管退出码，拿回它的标准输出（开工前的 oasis-setup.sh）；用户电脑上的沙箱没有 */
  run?(cmd: string[]): Promise<string>;
  /** 往沙箱的某个目录里再解一包文件（接着用时这一轮带来的文件、群里别的 AI 刚交的群文件） */
  put(dir: string, tar: Buffer | Readable): Promise<void>;
  /** 销毁沙箱（运行中也立即结束）；可重复调用 */
  destroy(): Promise<void>;
}

export interface Executor {
  /** 就绪检查：执行环境可用、镜像和网络都在 */
  check(): Promise<void>;
  start(spec: SandboxSpec): Promise<Sandbox>;
  /** 清理不在 keep（会话）里的沙箱（harness 重启后遗留的），返回清理了几个 */
  removeOrphans(keep: ReadonlySet<string>): Promise<number>;
  /** 接管前停止这份会话的旧进程，避免两份执行同时写同一目录。返回实际停止时间。 */
  suspend?(sessionId: string): Promise<{ endedAt: Date; cores?: number } | undefined>;
  /** 会话的持久工作目录还在（接着原会话做的唯一依据） */
  workspaceExists(sessionId: string): Promise<boolean>;
  purgeWorkspace(sessionId: string): Promise<void>;
  environment?(): Promise<ExecutionEnvironment>;
  /**
   * 把这个会话工作目录里的一个路径打成 tar 流取出，这一轮在不在跑都能取；取不到（路径不在、工作目录
   * 不在了）返回 undefined
   */
  readWorkspace(sessionId: string, path: string): Promise<Readable | undefined>;
  /**
   * 列出工作目录里一个目录下的文件和摘要（路径相对这个目录）。文件不在平台这边的地方（用户电脑）自己列，
   * 内容不用搬过来；没有这一项的由调用方取出来扫一遍
   */
  listWorkspace?(sessionId: string, path: string): Promise<WorkspaceFile[]>;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  sha256: string;
}

const LABEL_COMPONENT = 'oasis.component=harness-sandbox';
const LABEL_SESSION = 'oasis.session-id';
/** 一轮结束后读工作目录用的临时容器（只读挂着这个会话的卷，不启动） */
const LABEL_READER = 'oasis.component=harness-reader';
const volumeNames = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('工作目录身份不合法');
  return [`oasis-workspace-${id}`, `oasis-sessions-${id}`];
};
const cacheVolume = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error('缓存卷身份不合法');
  return `oasis-cache-${id}`;
};
/**
 * 在沙箱里清缓存卷（参数：目录、上限 KB）。按「工具 / 条目」这两层目录算：大小是里面文件的合计，最近用到的
 * 时间是里面文件最晚的一次读取（目录自己的时间不准：量大小时会被碰到）。整卷没超就不动；超了从最久没用的
 * 删起，删到上限的八成。bin/ 里只是连到工具链的链接，不删。一遍 find 走完，卷大时也只要一两秒。
 */
const TRIM_CACHE = `const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const [root,max]=[process.argv[1],Number(process.argv[2])];
const found=spawnSync('find',[root,'-type','f','-printf','%A@\\t%k\\t%P\\n'],{encoding:'utf8',maxBuffer:1<<28}).stdout;
const groups=new Map();let total=0;
for(const line of found.split('\\n')){
  const [at,kb,file]=line.split('\\t');if(!file)continue;
  const key=file.split('/').slice(0,2).join('/');const group=groups.get(key)||{at:0,kb:0};
  group.at=Math.max(group.at,Number(at));group.kb+=Number(kb);groups.set(key,group);total+=Number(kb);
}
if(total>max){
  const oldest=[...groups].filter(([key])=>key.split('/')[0]!=='bin').sort((a,b)=>a[1].at-b[1].at);
  for(const [key,group] of oldest){if(total<=max*0.8)break;fs.rmSync(path.join(root,key),{recursive:true,force:true});total-=group.kb}
}`;

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
  /** 每个用户一块的缓存卷挂在沙箱里哪个目录、最多占多少；不给就不挂 */
  cache?: { dir: string; maxMb: number };
}): Executor {
  const { docker } = deps;
  const instanceId = randomUUID();
  let detected: { imageId: string; value: Promise<ExecutionEnvironment> } | undefined;
  /** 正在删的读文件临时容器：删卷前等它们删完 */
  const dropping = new Set<Promise<void>>();
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
      if (deps.cache && spec.cacheId) {
        const name = cacheVolume(spec.cacheId);
        if (!(await docker.volume(name)))
          await docker.createVolume(name, {
            'oasis.component': 'harness-cache',
            'oasis.owner-id': spec.cacheId,
          });
        mounts.push({ Type: 'volume', Source: name, Target: deps.cache.dir });
      }
      // 这份会话留下的旧沙箱（服务重启前起的；要接着用的不会走到这里）：先删掉，不让两个 dsh 写同一份会话
      for (const previous of await docker.listContainers(LABEL_COMPONENT))
        if (previous.Labels[LABEL_SESSION] === spec.workspaceId)
          await docker.removeContainer(previous.Id);
      const { Id: id } = await docker.createContainer(`oasis-run-${spec.runId}`, {
        Image: deps.image,
        Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        Labels: { 'oasis.component': 'harness-sandbox', [LABEL_SESSION]: spec.workspaceId },
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
      /** 跑一条命令并等它结束，不管退出码，拿回标准输出 */
      const run = async (cmd: string[]) => {
        const started = await docker.exec(id, cmd);
        const output = new PassThrough();
        const errors = new PassThrough();
        errors.resume();
        demultiplex(started.stream, output, errors);
        return Buffer.concat(await output.toArray()).toString('utf8');
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
        // 缓存卷超过上限：从最久没用的删起。清不成不挡这一轮（下一轮再清）
        if (deps.cache && spec.cacheId)
          await exec([
            'node',
            '-e',
            TRIM_CACHE,
            deps.cache.dir,
            String(deps.cache.maxMb * 1024),
          ]).catch(() => undefined);
        return {
          id,
          stdin: connection,
          stdout,
          stderr,
          exec,
          run,
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

    async suspend(sessionId) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      const targets = containers.filter((c) => c.Labels[LABEL_SESSION] === sessionId);
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
    async readWorkspace(workspaceId, path) {
      const box = (await docker.listContainers(LABEL_COMPONENT)).find(
        (c) => c.Labels[LABEL_SESSION] === workspaceId,
      );
      if (box) return docker.getArchive(box.Id, path);
      // 沙箱已经销毁，文件在这个会话的卷里：建一个不启动的容器只读挂上卷来取，取完就删
      const [name] = volumeNames(workspaceId);
      if ((await docker.volume(name!))?.Labels?.['oasis.session-id'] !== workspaceId)
        return undefined;
      const { Id: id } = await docker.createContainer(`oasis-read-${randomUUID()}`, {
        Image: deps.image,
        Labels: {
          'oasis.component': 'harness-reader',
          'oasis.instance-id': instanceId,
          [LABEL_SESSION]: workspaceId,
        },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: name!, Target: deps.workdir, ReadOnly: true }],
          NetworkMode: 'none',
        },
      });
      const drop = () => {
        const removing = docker.removeContainer(id).catch(() => undefined);
        dropping.add(removing);
        void removing.finally(() => dropping.delete(removing));
      };
      const stream = await docker.getArchive(id, path).catch((err: unknown) => {
        drop();
        throw err;
      });
      if (stream) stream.once('close', drop);
      else drop();
      return stream;
    },
    async workspaceExists(sessionId) {
      const volumes = await Promise.all(volumeNames(sessionId).map((name) => docker.volume(name)));
      return volumes.every((v) => v?.Labels?.['oasis.session-id'] === sessionId);
    },
    async purgeWorkspace(sessionId) {
      // 正在读这个卷的临时容器（读的人还没读完或刚读完）先删掉，不然卷删不了
      for (const reader of await docker.listContainers(LABEL_READER))
        if (reader.Labels[LABEL_SESSION] === sessionId) await docker.removeContainer(reader.Id);
      await Promise.all(dropping);
      for (const name of volumeNames(sessionId)) {
        const volume = await docker.volume(name);
        if (volume?.Labels?.['oasis.session-id'] === sessionId) await docker.removeVolume(name);
      }
    },

    async removeOrphans(keep) {
      const containers = await docker.listContainers(LABEL_COMPONENT);
      const orphans = containers.filter((c) => !keep.has(c.Labels[LABEL_SESSION] ?? ''));
      for (const label of ['oasis.component=harness-probe', LABEL_READER])
        orphans.push(
          ...(await docker.listContainers(label)).filter(
            (c) => c.Labels['oasis.instance-id'] !== instanceId,
          ),
        );
      for (const container of orphans) await docker.removeContainer(container.Id);
      return orphans.length;
    },
  };
}
