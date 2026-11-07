import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { BrowserTestPlan, BrowserTestResult, UiTestReport } from '@oasis/contracts/ui-test';
import type { DockerApi } from './docker-api.ts';
import { demultiplex } from './executor.ts';
import { packFiles } from './tar.ts';

const seccompProfile = readFileSync(new URL('../../seccomp-profile.json', import.meta.url), 'utf8');

export interface LivePreview {
  id: string;
  frame(): { seq: number; jpegBase64: string } | undefined;
  diagnostics(): string[];
  /** 预览进程还在（进程退出或容器被回收后为 false） */
  alive(): boolean;
  test(plan: BrowserTestPlan): Promise<BrowserTestResult>;
  /** 画面检查：等页面画出来，返回是否一直是一整片纯色（ADR 0021） */
  look(): Promise<{ blank: boolean; color?: string }>;
  ready(): Promise<void>;
  destroy(): Promise<void>;
}

export function createPreviewExecutor(deps: {
  docker: DockerApi;
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  appPort: number;
}) {
  return {
    destroy: (id: string) => deps.docker.removeContainer(id),
    async check() {
      await deps.docker.ping();
      if (!(await deps.docker.imageExists(deps.image)))
        throw new Error(`预览镜像 ${deps.image} 不存在，请先运行 pnpm preview:build`);
    },
    async start(input: {
      id: string;
      kind: 'static' | 'node' | 'website';
      website?: {
        url: string;
        fetch(value: {
          url: string;
          method: string;
        }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
      };
      entry: string;
      files: { path: string; content: Buffer }[];
    }): Promise<LivePreview> {
      const { Id: id } = await deps.docker.createContainer(`oasis-preview-${input.id}`, {
        Image: deps.image,
        Env: [
          `APP_KIND=${input.kind}`,
          `APP_ENTRY=${input.entry}`,
          `APP_PORT=${deps.appPort}`,
          ...(input.website ? [`WEBSITE_URL=${input.website.url}`] : []),
        ],
        Labels: { 'oasis.component': 'preview', 'oasis.preview-id': input.id },
        WorkingDir: '/workspace/app',
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        HostConfig: {
          NetworkMode: 'none',
          NanoCpus: Math.round(deps.cpus * 1e9),
          Memory: deps.memoryMb * 1024 * 1024,
          PidsLimit: deps.pidsLimit,
          ShmSize: 256 * 1024 * 1024,
          CapDrop: ['ALL'],
          CapAdd: ['SYS_CHROOT'],
          SecurityOpt: ['no-new-privileges', `seccomp=${seccompProfile}`],
        },
      });
      let destroyed: Promise<void> | undefined;
      const destroy = () => (destroyed ??= deps.docker.removeContainer(id));
      try {
        await deps.docker.putArchive(id, '/workspace/app', await packFiles(input.files));
        const connection = await deps.docker.attach(id);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        demultiplex(connection, stdout, stderr);
        stderr.resume();
        let latest: { seq: number; jpegBase64: string } | undefined;
        let looking:
          | { accept(value: { blank: boolean; color?: string }): void; reject(error: Error): void }
          | undefined;
        // 页面诊断按内容去重并计数，不截断、不限条数
        const diagnostics = new Map<string, number>();
        let alive = true;
        let testResult:
          { accept(value: BrowserTestResult): void; reject(error: Error): void } | undefined;
        let screenshots: BrowserTestResult['screenshots'] = [];
        let testBroken = false;
        let resolved = false;
        let accept!: () => void;
        let reject!: (error: Error) => void;
        const ready = new Promise<void>((yes, no) => {
          accept = yes;
          reject = no;
        });
        const lines = readline.createInterface({ input: stdout });
        lines.on('line', (line) => {
          if (line.length > 3 * 1024 * 1024) return;
          let data: {
            kind?: string;
            seq?: number;
            jpegBase64?: string;
            message?: string;
            blank?: unknown;
            color?: unknown;
            report?: unknown;
            name?: unknown;
            base64?: unknown;
            id?: number;
            url?: string;
            method?: string;
          };
          try {
            data = JSON.parse(line);
          } catch {
            return;
          }
          if (
            data.kind === 'fetch' &&
            input.website &&
            Number.isInteger(data.id) &&
            typeof data.url === 'string' &&
            data.url.length < 4000 &&
            typeof data.method === 'string'
          ) {
            const id = data.id;
            void input.website
              .fetch({ url: data.url, method: data.method })
              .then((value) =>
                connection.write(`${JSON.stringify({ kind: 'fetch-result', id, ...value })}\n`),
              )
              .catch(() =>
                connection.write(`${JSON.stringify({ kind: 'fetch-result', id, error: true })}\n`),
              );
            return;
          }
          if (data.kind === 'test-screenshot' && testResult) {
            const parsed = BrowserTestResult.shape.screenshots.element.safeParse(data);
            if (parsed.success) screenshots.push(parsed.data);
            return;
          }
          if (data.kind === 'look-result' && looking) {
            looking.accept({
              blank: data.blank === true,
              ...(typeof data.color === 'string' ? { color: data.color.slice(0, 20) } : {}),
            });
            return;
          }
          if (data.kind === 'test-result' && testResult) {
            const parsed = UiTestReport.safeParse(data.report);
            if (parsed.success) testResult.accept({ report: parsed.data, screenshots });
            else testResult.reject(new Error('浏览器测试报告格式不合格'));
            return;
          }
          if (data.kind === 'ready' && !resolved) {
            resolved = true;
            accept();
          } else if (data.kind === 'error' && !resolved) {
            resolved = true;
            reject(new Error(data.message ?? '预览启动失败'));
          } else if (data.kind === 'error' && testResult) {
            // 测试中途控制端报错：如实结束这次测试，不让它一直等下去
            testResult.reject(new Error(data.message ?? '浏览器测试中断'));
          } else if (data.kind === 'error' && looking) {
            looking.reject(new Error(data.message ?? '画面检查中断'));
          } else if (data.kind === 'diagnostic' && typeof data.message === 'string')
            diagnostics.set(data.message, (diagnostics.get(data.message) ?? 0) + 1);
          else if (
            data.kind === 'frame' &&
            Number.isInteger(data.seq) &&
            typeof data.jpegBase64 === 'string' &&
            data.jpegBase64.length <= 2 * 1024 * 1024
          )
            latest = { seq: data.seq!, jpegBase64: data.jpegBase64 };
        });
        lines.on('close', () => {
          alive = false;
          testResult?.reject(new Error('浏览器测试进程提前结束'));
          looking?.reject(new Error('浏览器测试进程提前结束'));
          if (!resolved) {
            resolved = true;
            reject(new Error('预览进程提前结束'));
          }
        });
        await deps.docker.startContainer(id);
        return {
          id,
          frame: () => latest,
          diagnostics: () =>
            [...diagnostics].map(([message, times]) =>
              times > 1 ? `${message}（共 ${times} 次）` : message,
            ),
          alive: () => alive,
          test: async (value) => {
            const plan = BrowserTestPlan.parse(value);
            if (testBroken) throw new Error('浏览器测试会话已失效，请重新启动');
            if (testResult) throw new Error('浏览器正在测试');
            screenshots = [];
            // 不设时限：测试由控制端按页面安定与否下结论；进程退出或用户停止（回收容器）才提前结束
            try {
              return await new Promise<BrowserTestResult>((accept, reject) => {
                testResult = {
                  accept,
                  reject: (error) => {
                    testBroken = true;
                    reject(error);
                  },
                };
                connection.write(`${JSON.stringify({ kind: 'test', plan })}\n`);
              });
            } finally {
              testResult = undefined;
              screenshots = [];
            }
          },
          look: async () => {
            if (looking) throw new Error('浏览器正在做画面检查');
            // 不设时限：控制端按动画帧数下结论；进程退出时提前结束
            try {
              return await new Promise<{ blank: boolean; color?: string }>((accept, reject) => {
                looking = { accept, reject };
                connection.write(`${JSON.stringify({ kind: 'look' })}\n`);
              });
            } finally {
              looking = undefined;
            }
          },
          // 不设时限：控制端报告就绪或出错、进程退出时结束
          ready: () => ready,
          destroy,
        };
      } catch (error) {
        await destroy().catch(() => undefined);
        throw error;
      }
    },
    async removeOrphans(keep: ReadonlySet<string>) {
      const all = await deps.docker.listContainers('oasis.component=preview');
      const orphans = all.filter(
        (container) => !keep.has(container.Labels['oasis.preview-id'] ?? ''),
      );
      for (const container of orphans) await deps.docker.removeContainer(container.Id);
      return orphans.length;
    },
  };
}

export type PreviewExecutor = ReturnType<typeof createPreviewExecutor>;
