import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlaybooks, parsePlaybook } from '../src/repo/playbooks.ts';

describe('场景经验手册', () => {
  it('仓库里的手册都能读：有名称和「适用」', async () => {
    const list = await loadPlaybooks(fileURLToPath(new URL('../playbooks', import.meta.url)));
    expect(list.map((p) => p.key)).toEqual(['documents', 'images']);
    expect(list.find((p) => p.key === 'images')).toMatchObject({ name: '图片类' });
    for (const p of list) expect(p.when.length).toBeGreaterThan(5);
  });

  it('缺标题或「适用」行：报错', () => {
    expect(() => parsePlaybook('x', '正文')).toThrow('x.md');
    expect(parsePlaybook('x', '# 甲\n\n> 适用：乙\n\n正文')).toEqual({
      key: 'x',
      name: '甲',
      when: '乙',
      content: '# 甲\n\n> 适用：乙\n\n正文',
    });
  });
});
