import { describe, expect, it } from 'vitest';
import { parseArgs, targetsFor } from '../sandbox/oasis-tool.ts';

describe('oasis-tool', () => {
  it('解析 --名字 值；列表参数按逗号拆或读 JSON；--out、--file 单独拿出来', () => {
    expect(
      parseArgs([
        '--prompt',
        '山里的小木屋',
        '--n',
        '2',
        '--urls',
        'https://a.com, https://b.com',
        '--options',
        '["甲,乙","丙"]',
        '--out',
        'out/图.png',
      ]),
    ).toEqual({
      args: {
        prompt: '山里的小木屋',
        n: '2',
        urls: ['https://a.com', 'https://b.com'],
        options: ['甲,乙', '丙'],
      },
      out: 'out/图.png',
    });
    expect(parseArgs(['--file', 'in/录音.mp3'])).toEqual({ args: {}, file: 'in/录音.mp3' });
    expect(() => parseArgs(['prompt', 'x'])).toThrow('参数要写成 --名字 值');
    expect(() => parseArgs(['--prompt'])).toThrow('--prompt 后面缺少值');
  });

  it('文件存放位置：一个文件用 --out；多个加编号；没给 --out 就放进 out/', () => {
    const files = [
      { name: 'image-1.png', mediaType: 'image/png', base64: '' },
      { name: 'image-2.png', mediaType: 'image/png', base64: '' },
    ];
    expect(targetsFor(files.slice(0, 1), 'out/首屏.png')).toEqual(['out/首屏.png']);
    expect(targetsFor(files, 'out/首屏.png')).toEqual(['out/首屏-1.png', 'out/首屏-2.png']);
    expect(targetsFor(files, undefined)).toEqual(['out/image-1.png', 'out/image-2.png']);
  });
});
