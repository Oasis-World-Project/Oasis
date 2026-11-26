// E2B 上的沙箱：线上的云端。一份会话一个 E2B 沙箱（按会话打元数据），dsh 在里面常驻；文件进出走 E2B 的
// 文件接口。沙箱的盘就是这份会话的持久工作目录：做完不删，空着就暂停——暂停不收运行费，进程和内存都留着，
// 恢复约 1 秒（2026-11-26 实测），之前的 dsh 接着用；删对话、开新话题时才真的删掉。
// 沙箱只能访问放行的域名（Oasis 的 gateway、软件包仓库）：dsh 调模型和工具走公网上 gateway 的 /api/run/v1，
// 和用户电脑上的 dsh 同一条路、同一种临时 Key。接口和 Docker 执行器一样（executor.ts）。
import { randomUUID } from 'node:crypto';
import path from 'node:path/posix';
import { PassThrough, Readable, Writable } from 'node:stream';
import { ExecutionEnvironment } from '@oasis/contracts/harness';
import { readLimited, type Logger } from '@oasis/service-kit';
import { CommandExitError, Sandbox as Box, type CommandHandle } from 'e2b';
import { PROBE_SCRIPT, type Executor, type Sandbox, type WorkspaceFile } from './executor.ts';

/** 镜像配方里的环境变量（PATH、DSH_HOME……）：模板里的 ENV 对 E2B 起的命令不生效，建模板时写成了这个文件 */
const IMAGE_ENV = '/opt/oasis/image-env.sh';
const COMPONENT = 'harness-sandbox';
/** 为读一个文件把暂停的沙箱叫起来时，多久没动静让它再暂停 */
const READ_AWAKE_MS = 60_000;
/** 一次放进沙箱的文件包最多多大 */
const FILES_MAX_BYTES = 512 * 1024 * 1024;
/** 在沙箱里列一个目录下的文件和摘要（参数：目录）；目录不在时输出空列表 */
const LIST_SCRIPT = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const out=[],buf=Buffer.alloc(1<<20);
(function walk(dir,prefix){let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
for(const e of entries.sort((a,b)=>a.name<b.name?-1:1)){const file=path.join(dir,e.name);
if(e.isDirectory())walk(file,prefix+e.name+'/');else if(e.isFile()){const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r');let size=0,n;
while((n=fs.readSync(fd,buf,0,buf.length,null))>0){hash.update(buf.subarray(0,n));size+=n}fs.closeSync(fd);
out.push({path:prefix+e.name,size,sha256:hash.digest('hex')})}}})(process.argv[1],'');
process.stdout.write(JSON.stringify(out))`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function createE2bExecutor(deps: {
  apiKey: string;
  /** 模板名：按沙箱镜像的配方在 E2B 上建的（pnpm sandbox:e2b） */
  template: string;
  /** 沙箱连续运行多久到点自动暂停（E2B 档位的上限：Hobby 1 小时） */
  timeoutMs: number;
  /** 沙箱能访问的域名；别的出站一律不通 */
  allowOut: string[];
  workdir: string;
  logger: Logger;
}): Executor {
  const api = { apiKey: deps.apiKey };
  const metadataOf = (sessionId: string) => ({
    oasisComponent: COMPONENT,
    oasisSession: sessionId,
  });
  /** 正被读着文件的会话：清理时别把它的沙箱暂停掉 */
  const reading = new Map<string, number>();
  let detected: Promise<ExecutionEnvironment> | undefined;

  const find = async (sessionId: string) =>
    (await Box.list({ ...api, query: { metadata: metadataOf(sessionId) } }).nextItems())[0];

  /** 结束沙箱里 node 用户的所有进程（dsh 和它起的命令），和销毁容器一个效果，盘留着 */
  const sweep = (box: Box) =>
    box.commands.run('pkill -KILL -u node; true', { user: 'root', timeoutMs: 30_000 });

  async function put(box: Box, dir: string, tar: Buffer | Readable) {
    const tmp = `/tmp/oasis-put-${randomUUID()}.tar`;
    const data = Buffer.isBuffer(tar) ? tar : await readLimited(tar, FILES_MAX_BYTES);
    await box.files.write(tmp, new Uint8Array(data), { user: 'root' });
    // 用 root 解：包里的条目写着属主（沙箱用户），和 Docker 解出来的一样
    await box.commands.run(
      `mkdir -p ${quote(dir)} && tar -xf ${tmp} -C ${quote(dir)}; code=$?; rm -f ${tmp}; exit $code`,
      { user: 'root', timeoutMs: 0 },
    );
  }

  /** 把沙箱里的一个路径打成 tar 流取出（条目以它的名字开头，和 Docker 取出的一样）；不存在返回 undefined */
  async function archive(
    box: Box,
    target: string,
    done?: () => void,
  ): Promise<Readable | undefined> {
    const tmp = `/tmp/oasis-read-${randomUUID()}.tar`;
    const packed = await box.commands
      .run(
        `[ -e ${quote(target)} ] && tar -cf ${tmp} -C ${quote(path.dirname(target))} ${quote(path.basename(target))}`,
        { user: 'root', timeoutMs: 0 },
      )
      .then(
        () => true,
        (err: unknown) => {
          if (err instanceof CommandExitError) return false;
          throw err;
        },
      );
    if (!packed) {
      done?.();
      return undefined;
    }
    const stream = Readable.fromWeb(
      (await box.files.read(tmp, {
        format: 'stream',
        user: 'root',
        streamIdleTimeoutMs: 0,
      })) as never,
    );
    stream.once('close', () => {
      done?.();
      void box.files.remove(tmp, { user: 'root' }).catch(() => undefined);
    });
    return stream;
  }

  /** 连上这份会话的沙箱去读（暂停着的先叫起来，读完没动静自己再暂停）；没有这份会话返回 undefined */
  async function visit(sessionId: string) {
    const found = await find(sessionId);
    if (!found) return undefined;
    reading.set(sessionId, (reading.get(sessionId) ?? 0) + 1);
    const done = () => {
      const left = (reading.get(sessionId) ?? 1) - 1;
      if (left > 0) reading.set(sessionId, left);
      else reading.delete(sessionId);
    };
    try {
      return {
        box: await Box.connect(found.sandboxId, { ...api, timeoutMs: READ_AWAKE_MS }),
        done,
      };
    } catch (err) {
      done();
      throw err;
    }
  }

  return {
    async check() {
      await Box.list({ ...api, limit: 1 }).nextItems();
    },

    /** 沙箱里装了什么：开一个沙箱探测一次，之后记着（换了模板要重启服务） */
    environment() {
      detected ??= (async () => {
        const box = await Box.create(deps.template, { ...api, timeoutMs: 120_000 });
        try {
          const { stdout } = await box.commands.run(`. ${IMAGE_ENV}; node -e "$OASIS_PROBE"`, {
            user: 'node',
            envs: { OASIS_PROBE: PROBE_SCRIPT },
            timeoutMs: 90_000,
          });
          return ExecutionEnvironment.parse({
            image: deps.template,
            imageId: box.sandboxId,
            ...JSON.parse(stdout),
          });
        } finally {
          await box.kill().catch(() => undefined);
        }
      })();
      detected.catch(() => {
        detected = undefined;
      });
      return detected;
    },

    async start(spec) {
      const existing = await find(spec.workspaceId);
      if (!existing && spec.restore) throw new Error('原运行持久工作目录缺失，不能从空目录恢复');
      let box = existing
        ? await Box.connect(existing.sandboxId, { ...api, timeoutMs: deps.timeoutMs })
        : await Box.create(deps.template, {
            ...api,
            timeoutMs: deps.timeoutMs,
            metadata: metadataOf(spec.workspaceId),
            lifecycle: { onTimeout: 'pause' },
            network: { allowOut: deps.allowOut, denyOut: ['0.0.0.0/0'] },
          });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let asleep = false;
      let ended: Promise<void> | undefined;
      let current: CommandHandle<string | undefined> | undefined;
      /** dsh 真的退出了（不是沙箱暂停断开的）才算输出结束 */
      const watch = (handle: CommandHandle<string | undefined>) => {
        current = handle;
        void handle
          .wait()
          .catch(() => undefined)
          .then(() => {
            if (current !== handle || asleep) return;
            stdout.end();
            stderr.end();
          });
      };
      const output = {
        onStdout: (data: string) => void stdout.write(data),
        onStderr: (data: string) => void stderr.write(data),
        retainOutput: false,
        timeoutMs: 0,
      };
      const command = (cmd: string[]) => `. ${IMAGE_ENV}; ${cmd.map(quote).join(' ')}`;
      const commandOpts = {
        user: 'node',
        cwd: deps.workdir,
        envs: spec.env,
        timeoutMs: 0,
      } as const;
      try {
        // 这份会话留下的旧进程（服务重启前起的 dsh）：先结束，不让两个 dsh 写同一份会话
        if (existing) await sweep(box);
        for (const file of spec.files) await put(box, file.dir, file.tar);
        const handle = await box.commands.run(`. ${IMAGE_ENV} && exec dsh --profile oasis`, {
          ...commandOpts,
          ...output,
          background: true,
          stdin: true,
        });
        const { pid } = handle;
        watch(handle);
        const sandbox: Sandbox = {
          id: box.sandboxId,
          stdin: new Writable({
            decodeStrings: false,
            write(chunk: string | Buffer, _encoding, done) {
              box.commands.sendStdin(pid, String(chunk)).then(() => done(), done);
            },
          }),
          stdout,
          stderr,
          put: (dir, tar) => put(box, dir, tar),
          readArchive: (target) => archive(box, target),
          async exec(cmd) {
            await box.commands.run(command(cmd), commandOpts).catch((err: unknown) => {
              if (err instanceof CommandExitError)
                throw new Error(`沙箱里的命令没成功（退出码 ${err.exitCode}）`);
              throw err;
            });
          },
          run: (cmd) =>
            box.commands.run(command(cmd), commandOpts).then(
              (result) => result.stdout,
              (err: unknown) => {
                if (err instanceof CommandExitError) return err.stdout;
                throw err;
              },
            ),
          // 停下：dsh 和它起的命令都结束，之后再列产出
          pause: async () => void (await sweep(box)),
          /** 空着：整个沙箱暂停，dsh 留在里面 */
          async sleep() {
            asleep = true;
            await box.pause();
          },
          /** 下一轮来了：恢复沙箱，重新接上 dsh 的输出 */
          async wake() {
            box = await Box.connect(box.sandboxId, { ...api, timeoutMs: deps.timeoutMs });
            watch(await box.commands.connect(pid, output));
            asleep = false;
          },
          // 收掉：进程都结束，沙箱暂停——盘是这份会话的工作目录，不能删
          destroy: () =>
            (ended ??= (async () => {
              current = undefined;
              if (asleep) return;
              await sweep(box).catch(() => undefined);
              stdout.end();
              stderr.end();
              await box.pause();
            })()),
        };
        return sandbox;
      } catch (err) {
        await box.pause().catch(() => undefined);
        throw err;
      }
    },

    async suspend(sessionId) {
      const found = await find(sessionId);
      if (!found) return undefined;
      if (found.state === 'running') await Box.pause(found.sandboxId, api);
      return { endedAt: new Date() };
    },

    async readWorkspace(sessionId, target) {
      const visiting = await visit(sessionId);
      return visiting ? archive(visiting.box, target, visiting.done) : undefined;
    },

    async listWorkspace(sessionId, dir) {
      const visiting = await visit(sessionId);
      if (!visiting) return [];
      try {
        const { stdout } = await visiting.box.commands.run(`node -e "$OASIS_LIST" ${quote(dir)}`, {
          user: 'node',
          envs: { OASIS_LIST: LIST_SCRIPT },
          timeoutMs: 0,
        });
        return JSON.parse(stdout) as WorkspaceFile[];
      } finally {
        visiting.done();
      }
    },

    workspaceExists: async (sessionId) => Boolean(await find(sessionId)),

    async purgeWorkspace(sessionId) {
      const pages = Box.list({ ...api, query: { metadata: metadataOf(sessionId) } });
      while (pages.hasNext)
        for (const found of await pages.nextItems()) await Box.kill(found.sandboxId, api);
    },

    /** 还在运行、又不在 keep（会话）里的沙箱：暂停（盘是会话的工作目录，不删） */
    async removeOrphans(keep) {
      let paused = 0;
      const pages = Box.list({
        ...api,
        query: { metadata: { oasisComponent: COMPONENT }, state: ['running'] },
      });
      while (pages.hasNext)
        for (const found of await pages.nextItems()) {
          const session = found.metadata.oasisSession ?? '';
          if (keep.has(session) || reading.has(session)) continue;
          await Box.pause(found.sandboxId, api).catch((err: unknown) =>
            deps.logger.warn({ err, session }, '遗留的沙箱没能暂停'),
          );
          paused += 1;
        }
      return paused;
    },
  };
}
