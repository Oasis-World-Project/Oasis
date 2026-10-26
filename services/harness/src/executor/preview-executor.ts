import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import type { PreviewInputBody } from '@oasis/contracts/harness';
import type { DockerApi } from './docker-api.ts';
import { demultiplex } from './executor.ts';
import { packFiles } from './tar.ts';

const seccompProfile = readFileSync(new URL('../../seccomp-profile.json', import.meta.url), 'utf8');

export interface LivePreview {
  id: string;
  frame(): { seq: number; jpegBase64: string } | undefined;
  audio(afterSeq: number): { seq: number; webmBase64: string }[];
  diagnostics(): string[];
  input(value: PreviewInputBody): void;
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
      kind: 'static' | 'node';
      entry: string;
      files: { path: string; content: Buffer }[];
    }): Promise<LivePreview> {
      const { Id: id } = await deps.docker.createContainer(`oasis-preview-${input.id}`, {
        Image: deps.image,
        Env: [`APP_KIND=${input.kind}`, `APP_ENTRY=${input.entry}`, `APP_PORT=${deps.appPort}`],
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
        const audio: { seq: number; webmBase64: string }[] = [];
        const diagnostics: string[] = [];
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
            webmBase64?: string;
            message?: string;
          };
          try {
            data = JSON.parse(line);
          } catch {
            return;
          }
          if (data.kind === 'ready' && !resolved) {
            resolved = true;
            accept();
          } else if (data.kind === 'error' && !resolved) {
            resolved = true;
            reject(new Error(data.message ?? '预览启动失败'));
          } else if (
            data.kind === 'diagnostic' &&
            typeof data.message === 'string' &&
            diagnostics.length < 20
          )
            diagnostics.push(data.message.slice(0, 300));
          else if (
            data.kind === 'audio' &&
            Number.isInteger(data.seq) &&
            typeof data.webmBase64 === 'string' &&
            data.webmBase64.length <= 128 * 1024
          ) {
            audio.push({ seq: data.seq!, webmBase64: data.webmBase64 });
            if (audio.length > 80) audio.shift();
          } else if (
            data.kind === 'frame' &&
            Number.isInteger(data.seq) &&
            typeof data.jpegBase64 === 'string' &&
            data.jpegBase64.length <= 2 * 1024 * 1024
          )
            latest = { seq: data.seq!, jpegBase64: data.jpegBase64 };
        });
        lines.on('close', () => {
          if (!resolved) {
            resolved = true;
            reject(new Error('预览进程提前结束'));
          }
        });
        await deps.docker.startContainer(id);
        return {
          id,
          frame: () => latest,
          audio: (afterSeq) => audio.filter((chunk) => chunk.seq > afterSeq).slice(0, 20),
          diagnostics: () => [...diagnostics],
          input: (value) => {
            connection.write(`${JSON.stringify(value)}\n`);
          },
          ready: () =>
            Promise.race([
              ready,
              new Promise<never>((_, no) =>
                setTimeout(() => no(new Error('预览启动超时')), 25_000),
              ),
            ]),
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
