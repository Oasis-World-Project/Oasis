// 成果的类别和同步路径怎么定（纯函数）。
import { describe, expect, it } from 'vitest';
import { categoryOf, safeSegment, uniqueName } from '../src/service/naming.ts';

describe('类别和同步路径的规则', () => {
  it('按扩展名分类，认不出的算数据和其他', () => {
    expect(['a.mp4', 'b.glb', 'site/index.html', 'c.xlsx', 'README'].map(categoryOf)).toEqual([
      'media',
      'threed',
      'app',
      'data',
      'data',
    ]);
  });

  it('文件名在 Windows 上也能用；重名加序号（不分大小写）', () => {
    expect(safeSegment('a<b>:c?. ')).toBe('a_b__c_');
    expect(safeSegment('CON.txt')).toBe('CON.txt_');
    expect(safeSegment('...')).toBe('未命名');
    expect(uniqueName('报告.md', new Set(['报告.md', '报告 (2).md']), true)).toBe('报告 (3).md');
    expect(uniqueName('Site', new Set(['site']), false)).toBe('Site (2)');
  });
});
