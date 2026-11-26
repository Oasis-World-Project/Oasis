// 干活的地方（一份会话一个）：沙箱、里面一直开着的 dsh、它手里的临时 Key。一轮做完不收，空闲一段时间
// 才收；同一份会话的下一轮直接接着用，不用再起沙箱、起 dsh、读会话记录。停下、出错、设置变了（型号、权限、
// 说明和技能）就收掉，下一轮重起、接上原会话。只在这个进程里：服务重启后都不在了，下一轮重起。
// 这里是怎么起一个、怎么留着、怎么收；一轮怎么用它在 execute.ts。
import { createHash } from 'node:crypto';
import type { RunEventBody } from '@oasis/contracts/harness';
import type { RunKeyCreated } from '@oasis/contracts/model-gateway';
import { packFiles, packStreams, scanArchive } from '@oasis/service-kit';
import {
  connectAgent,
  guideFiles,
  isSessionArchive,
  runtimeFiles,
  SANDBOX_PATHS,
  sandboxEnv,
  type AgentConnection,
} from '../../adapter/dsh.ts';
import type { Executor, Sandbox } from '../../executor/executor.ts';
import type { Run } from '../../repo/runs-repo.ts';
import { setupNote } from './setup.ts';
import { KEEP_FILE, type RunContext, type RunDeps } from './shared.ts';

type Request = Parameters<RunContext['execute']>[1];
type Catalog = Parameters<RunContext['execute']>[3];

/** dsh 的事件和准备中的进展交给现在这一轮；两轮之间没人接 */
export interface Relay {
  to?: (kind: RunEventBody['kind'], data: Record<string, unknown>) => void;
}

export interface Host {
  readonly workspaceId: string;
  /** 起它时定死的东西（环境变量、说明、技能、命令）的摘要：变了就不能接着用 */
  readonly signature: string;
  readonly sandbox: Sandbox;
  readonly agent: AgentConnection;
  readonly keyId: string;
  readonly relay: Relay;
}

/** 歇着的沙箱（里面的 dsh 还留着）最多留多久：过了就收掉，下一轮重起 dsh、接上原会话 */
const RETIRE_MS = 24 * 3600_000;

const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

export function createHosts(deps: RunDeps) {
  const { repo } = deps;
  const idle = new Map<string, { host: Host; timer: NodeJS.Timeout; asleep?: Promise<void> }>();

  /**
   * 起 dsh 时定死的东西：环境变量（除了 Key）、平台说明（带这个 AI 的人设）和技能、oasis-tool 这些命令和
   * dsh 组合。每轮现读：没变就接着用空着的那个 dsh，变了（改了说明、换了权限）就重起一个用上新的。
   */
  async function fixture(row: Run, request: Request, catalog: Catalog, recovering: boolean) {
    const workspaceId = row.sessionId ?? row.id;
    const env = (runKey: string) => ({
      ...deps.batchEnv,
      OASIS_TOOL_SCOPE: workspaceId,
      ...sandboxEnv({
        runKey,
        model: row.model,
        place:
          request.workplace.kind === 'device'
            ? { workplace: request.workplace, permissions: request.permissions }
            : { modelBaseUrl: deps.modelBaseUrl, packages: deps.packages },
      }),
    });
    const files = [
      {
        dir: SANDBOX_PATHS.workdir,
        files: [
          ...runtimeFiles({ ...catalog, sessionId: workspaceId, recovering }),
          // 保证 out/ 目录存在且属于沙箱用户
          { path: `out/${KEEP_FILE}`, content: Buffer.alloc(0) },
        ],
      },
      {
        dir: SANDBOX_PATHS.dshHome,
        files: guideFiles(
          await deps.guide(),
          request.persona,
          request.workplace,
          request.scene,
          request.permissions.web !== false,
        ),
      },
      ...(deps.sandboxFiles ? await deps.sandboxFiles() : []),
    ];
    return {
      env,
      files,
      signature: digest(
        JSON.stringify([
          request.workplace,
          env(''),
          files.map((group) => [group.dir, group.files.map((f) => [f.path, digest(f.content)])]),
        ]),
      ),
    };
  }

  /** 新起一个干活的地方：起沙箱、放好文件、接上 dsh（还没握手）。stderr：dsh 标准错误的末尾 */
  async function open(input: {
    row: Run;
    executor: Executor;
    fixed: Awaited<ReturnType<typeof fixture>>;
    key: RunKeyCreated;
    /** 接着原会话或接管：持久卷必须已经在，不能从空目录假装恢复 */
    restore: boolean;
    /** 这一轮带来的文件（接管时工作目录里已经有了，不给） */
    materials?: Parameters<typeof packStreams>[0];
    relay: Relay;
  }): Promise<{ host: Host; stderr: () => string }> {
    const { row, fixed, relay } = input;
    const workspaceId = row.sessionId ?? row.id;
    const sandbox = await input.executor.start({
      runId: row.id,
      workspaceId,
      restore: input.restore,
      cacheId: row.payerId,
      env: fixed.env(input.key.key),
      notify: (status) => relay.to?.('status', { status }),
      files: [
        ...(await Promise.all(
          fixed.files.map(async ({ dir, files }) => ({ dir, tar: await packFiles(files) })),
        )),
        ...(input.materials
          ? [{ dir: SANDBOX_PATHS.workdir, tar: packStreams(input.materials) }]
          : []),
      ],
    });
    let stderrTail = '';
    sandbox.stderr.setEncoding('utf8');
    sandbox.stderr.on('data', (text: string) => {
      stderrTail = (stderrTail + text).slice(-2000);
    });
    const agent = connectAgent({
      stdin: sandbox.stdin,
      stdout: sandbox.stdout,
      sessionId: workspaceId,
      onEvent: (event) => relay.to?.(event.kind, event.data),
    });
    return {
      host: {
        workspaceId,
        signature: fixed.signature,
        sandbox,
        agent,
        keyId: input.key.keyId,
        relay,
      },
      stderr: () => stderrTail,
    };
  }

  /**
   * 新起的 dsh：项目里有 oasis-setup.sh 就先执行，握手，接着上一轮或接管时恢复原会话。
   * 返回接在用户的话后面的开工结果，和这一轮是不是从没交过话（接管时原进程还没建会话）
   */
  async function greet(input: {
    row: Run;
    host: Host;
    recovering: boolean;
    stopped: () => void;
    stderr: () => string;
  }): Promise<{ setup: string; unsaid: boolean }> {
    const { row, host, recovering } = input;
    const setup = await setupNote(host.sandbox, SANDBOX_PATHS.workdir, deps.setupSeconds ?? 300);
    try {
      // 用户电脑上工作目录是用户选的项目文件夹
      await host.agent.initialize(row.model, row.workplace?.folder ?? SANDBOX_PATHS.workdir);
    } catch (err) {
      input.stopped();
      throw new Error(`dsh 启动失败：${String(err)}；stderr：${input.stderr()}`, { cause: err });
    }
    let unsaid = false;
    if (recovering) {
      const source = await host.sandbox.readArchive(SANDBOX_PATHS.sessions);
      const paths = source
        ? (await scanArchive(source, deps.outputMaxBytes)).map((f) => f.path)
        : [];
      if (!paths.some((p) => isSessionArchive(p, host.workspaceId))) {
        if (paths.some((p) => isSessionArchive(p)) || (await repo.hasRootPrompt(row.id)))
          throw new Error('原生根会话缺失，不能丢弃已有历史');
        unsaid = true; // 原进程尚未创建原生会话，原子保存的请求仍可首次派发。
      }
    }
    if (row.continueFrom || (recovering && !unsaid)) await host.agent.resume();
    return { setup, unsaid };
  }

  /** 让 dsh 退出、销毁沙箱；返回沙箱有没有销毁成 */
  async function stop(host: Host): Promise<boolean> {
    host.relay.to = undefined;
    await host.agent.shutdown().catch(() => undefined);
    return host.sandbox.destroy().then(
      () => true,
      (err: unknown) => {
        deps.logger.warn({ err, workspaceId: host.workspaceId }, '销毁沙箱失败');
        return false;
      },
    );
  }

  /** 收掉空着的：让 dsh 退出、销毁沙箱、作废它手里的 Key */
  async function close(host: Host): Promise<void> {
    await stop(host);
    await deps.modelGateway
      .json('POST', `/internal/run-keys/${host.keyId}/revoke`, {
        body: {},
        requestId: host.workspaceId,
      })
      .catch((err: unknown) =>
        deps.logger.warn({ err, workspaceId: host.workspaceId }, '作废临时 Key 失败，等它过期'),
      );
  }

  /** 从空着的里面拿走 */
  function claim(workspaceId: string): Host | undefined {
    const waiting = idle.get(workspaceId);
    if (!waiting) return undefined;
    clearTimeout(waiting.timer);
    idle.delete(workspaceId);
    return waiting.host;
  }

  return {
    fixture,
    open,
    greet,
    /** 一轮没做成（停下、出错）：只收沙箱和 dsh，Key 由这一轮结清算力后自己作废 */
    stop,
    close,

    /** 这份会话空着的那个：还能用就拿走接着用（歇着的先叫醒）；设置变了或 dsh 已经不在了就收掉，返回 undefined */
    async take(workspaceId: string, signature: string): Promise<Host | undefined> {
      const waiting = idle.get(workspaceId);
      const host = claim(workspaceId);
      if (!host) return undefined;
      if (host.signature === signature && host.agent.alive()) {
        const awake = await (waiting?.asleep ?? Promise.resolve())
          .then(() => (waiting?.asleep ? host.sandbox.wake?.() : undefined))
          .then(
            () => true,
            (err: unknown) => {
              deps.logger.warn({ err, workspaceId }, '歇着的沙箱没叫醒，重起一个');
              return false;
            },
          );
        if (awake && host.agent.alive()) return host;
      }
      await close(host);
      return undefined;
    },

    /**
     * 这一轮做完了：留着等下一轮。idleMs 之后还没人用——能歇着的（E2B：暂停，不收运行费，dsh 原样留着）
     * 就歇着，再过 RETIRE_MS 才收掉；不能的直接收掉
     */
    park(host: Host, idleMs: number): void {
      host.relay.to = undefined;
      const { workspaceId } = host;
      const mine = () => idle.get(workspaceId)?.host === host;
      const retire = () => {
        if (!mine()) return;
        idle.delete(workspaceId);
        void close(host);
      };
      const timer = setTimeout(() => {
        const waiting = idle.get(workspaceId);
        if (!waiting || waiting.host !== host) return;
        if (!host.sandbox.sleep) return retire();
        waiting.asleep = host.sandbox.sleep().catch((err: unknown) => {
          deps.logger.warn({ err, workspaceId }, '沙箱没能歇下，收掉');
          retire();
        });
        waiting.timer = setTimeout(retire, RETIRE_MS);
        waiting.timer.unref();
      }, idleMs);
      timer.unref();
      idle.set(workspaceId, { host, timer });
    },

    /** 删对话、开新话题：这份会话空着的那个马上收掉 */
    async drop(workspaceId: string): Promise<void> {
      const host = claim(workspaceId);
      if (host) await close(host);
    },

    /** 空着留用的是哪些会话（清理遗留沙箱时别动它们） */
    parked: () => [...idle.keys()],

    /** 服务关闭：空着的都收掉 */
    async closeAll(): Promise<void> {
      await Promise.all([...idle.keys()].map((workspaceId) => close(claim(workspaceId)!)));
    },
  };
}

export type Hosts = ReturnType<typeof createHosts>;
