import { Readable } from 'node:stream';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { listFiles, packFiles, packStreams, readLimited, scanArchive } from '../src/archive.ts';

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

  it('流式组包的来源校验失败时中止，不能把损坏材料送进容器', async () => {
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
