import { PassThrough, Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { describe, expect, it, vi } from 'vitest';
import { createDockerApi, defaultDockerSocket } from '../src/executor/docker-api.ts';
import { createDockerExecutor, demultiplex } from '../src/executor/executor.ts';
import {
  listFiles,
  packFiles,
  packStreams,
  readLimited,
  scanArchive,
} from '../src/executor/tar.ts';

const frame = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE)('实际镜像环境探测', () => {
  it('从实际二进制探测并按镜像摘要缓存，不宣称不存在的本地浏览器', async () => {
    const docker = createDockerApi(defaultDockerSocket());
    const executor = createDockerExecutor({
      docker: {
        ...docker,
        createContainer: (name, spec) =>
          docker.createContainer(name, {
            ...spec,
            Labels: {
              ...(spec.Labels as Record<string, string>),
              'oasis.component': 'harness-probe-test',
            },
          }),
      },
      image: process.env.OASIS_NATIVE_IMAGE!,
      network: 'none',
      cpus: 1,
      memoryMb: 2048,
      pidsLimit: 512,
      workdir: '/workspace',
    });
    const result = await executor.environment!();
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['node', 'python', 'ffmpeg', 'libreoffice', 'pdf']),
    );
    expect(result.imageId).toMatch(/^sha256:/);
    expect(result.capabilities).not.toContain('browser');
    expect((await executor.environment!()).imageId).toBe(result.imageId);
    if (process.env.OASIS_NATIVE_IMAGE!.includes('sandbox-3d'))
      expect(result.capabilities).toContain('blender');
  }, 90000);
});

describe('Docker 接管停止证据', () => {
  it.each([true, false])('容器存在=%s：只报告匹配运行的实际停止时间', async (exists) => {
    const stopContainer = vi.fn(async () => undefined);
    const inspectContainer = vi.fn(async () => ({
      State: { Running: false, Paused: false, FinishedAt: '2026-11-04T01:00:00.000Z' },
      HostConfig: { NanoCpus: 2e9 },
    }));
    const executor = createDockerExecutor({
      docker: {
        ...createDockerApi(defaultDockerSocket()),
        listContainers: async () => [
          { Id: 'other', Labels: { 'oasis.run-id': 'other' } },
          ...(exists ? [{ Id: 'ours', Labels: { 'oasis.run-id': 'ours' } }] : []),
        ],
        stopContainer,
        inspectContainer,
      },
      image: 'oasis/test:1',
      network: 'none',
      cpus: 1,
      memoryMb: 1024,
      pidsLimit: 128,
      workdir: '/workspace',
    });
    const evidence = await executor.suspend!('ours');
    if (exists) {
      expect(evidence).toEqual({ endedAt: new Date('2026-11-04T01:00:00.000Z'), cores: 2 });
      expect(stopContainer.mock.calls).toEqual([['ours']]);
      expect(inspectContainer.mock.calls).toEqual([['ours']]);
    } else {
      expect(evidence).toBeUndefined();
      expect(stopContainer).not.toHaveBeenCalled();
      expect(inspectContainer).not.toHaveBeenCalled();
    }
  });
});

describe('Docker 输出拆流', () => {
  it('按帧头把 stdout 和 stderr 分开，帧被拆成几段也能拼回来', async () => {
    const source = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    demultiplex(source, stdout, stderr);
    const all = Buffer.concat([frame(1, '{"a":1}\n'), frame(2, 'warn'), frame(1, '{"b":2}\n')]);
    source.write(all.subarray(0, 5));
    source.write(all.subarray(5, 20));
    source.end(all.subarray(20));
    const read = async (s: PassThrough) => Buffer.concat(await s.toArray()).toString();
    expect(await read(stdout)).toBe('{"a":1}\n{"b":2}\n');
    expect(await read(stderr)).toBe('warn');
  });

  it('默认 socket：Windows 用 Docker Desktop 的命名管道', () => {
    expect(defaultDockerSocket('win32')).toBe('//./pipe/docker_engine');
    expect(defaultDockerSocket('linux')).toBe('/var/run/docker.sock');
  });
});

describe('tar 小工具', () => {
  it('打包后能列出文件，并去掉 Docker 取出时带的顶层目录', async () => {
    const tar = await packFiles([
      { path: 'out/a.md', content: Buffer.from('aa') },
      { path: 'out/sub/b.png', content: Buffer.alloc(10) },
    ]);
    expect(await listFiles(tar)).toEqual([
      { path: 'a.md', size: 2 },
      { path: 'sub/b.png', size: 10 },
    ]);
  });

  it('超过大小上限就报错', async () => {
    await expect(
      readLimited(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15),
    ).rejects.toThrow('产出超过上限');
  });

  it('流式归档拒绝越界、重复路径和符号链接', async () => {
    const oversized = await packFiles([{ path: 'out/a.wav', content: Buffer.alloc(10) }]);
    await expect(scanArchive(Readable.from([oversized]), 9)).rejects.toThrow('归档大小');
    const duplicated = await packFiles([
      { path: 'out/a.wav', content: Buffer.from('a') },
      { path: 'out/a.wav', content: Buffer.from('b') },
    ]);
    await expect(scanArchive(Readable.from([duplicated]), 100)).rejects.toThrow('文件名');
    const unsafe = await packFiles([{ path: 'out/../a', content: Buffer.from('a') }]);
    await expect(scanArchive(Readable.from([unsafe]), 100)).rejects.toThrow('不安全路径');
    const linked = pack();
    linked.entry({ name: 'out/a.wav', type: 'symlink', linkname: '/etc/passwd' });
    linked.finalize();
    await expect(scanArchive(Readable.from(linked), 100)).rejects.toThrow('非常规文件');
  });

  it('流式组包的来源校验失败时中止，不能把损坏材料送入沙箱', async () => {
    const stream = packStreams([
      {
        path: 'materials/a.wav',
        size: 3,
        sha256: '0'.repeat(64),
        open: async () => Readable.from([Buffer.from('abc')]),
      },
    ]);
    await expect(readLimited(stream, 10000)).rejects.toThrow('校验和不一致');
  });
});
