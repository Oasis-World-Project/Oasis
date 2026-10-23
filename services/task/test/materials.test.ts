import { describe, expect, it } from 'vitest';
import { materialPaths } from '../src/service/materials.ts';

const m = (name: string, n: number) => ({
  uploadId: `11111111-0000-4000-8000-00000000000${n}`,
  name,
  size: 1,
});

describe('素材在沙箱里的路径', () => {
  it('同名（不分大小写）的加序号，没有扩展名的也行', () => {
    expect(
      materialPaths([
        m('a.png', 1),
        m('A.png', 2),
        m('a.png', 3),
        m('README', 4),
        m('README', 5),
      ]).map((x) => x.path),
    ).toEqual([
      'materials/a.png',
      'materials/A (2).png',
      'materials/a (3).png',
      'materials/README',
      'materials/README (2)',
    ]);
  });
});
