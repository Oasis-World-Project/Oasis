import { describe, expect, it } from 'vitest';
import type { Node } from '../src/repo/task-store.ts';
import {
  deliveryManifest,
  selectDeliverables,
  missingDeliveryFiles,
} from '../src/service/output-files.ts';

const node = (deliver?: string[]) =>
  ({
    id: 'node',
    outputs: [
      { path: '最终/报告.docx', size: 10 },
      { path: '最终/报告.pdf', size: 20 },
      { path: '草稿.md', size: 30 },
      { path: '最终/空.pdf', size: 0 },
    ],
    config: deliver === undefined ? {} : { deliver },
  }) as Node;
const deliverables = [{ name: '报告', form: 'DOCX+PDF', nodeId: 'node' }];
describe('最终文件清单', () => {
  it('每个最终路径都须匹配，其他文件不能掩盖漏交；递归目录必须明确选择', () => {
    const outputs = [
      { path: 'final.mp4', size: 100 },
      { path: '素材包/scripts/build.py', size: 20 },
    ];
    expect(missingDeliveryFiles(outputs, ['final.mp4', 'named.mlt', '素材包/*'])).toEqual([
      '最终交付缺少文件 out/named.mlt',
      '最终交付缺少文件 out/素材包/*',
    ]);
    expect(missingDeliveryFiles(outputs, ['final.mp4', '素材包/**'])).toEqual([]);
  });
  it('按独立 deliver 选择实际文件，保留配套 PDF，排除草稿和空文件；不会修改节点产出', () => {
    const nodes = [node(['最终/*.docx', '最终/*.pdf'])];
    const selected = selectDeliverables(deliverables, nodes);
    expect(deliveryManifest(selected, nodes)?.map((f) => f.path)).toEqual([
      '最终/报告.docx',
      '最终/报告.pdf',
    ]);
    expect(nodes[0]?.outputs).toHaveLength(4);
  });
  it('旧任务不生成新清单；显式空清单不回退，重复文件只交付一次', () => {
    expect(deliveryManifest(selectDeliverables(deliverables, [node()]), [node()])).toBeUndefined();
    expect(deliveryManifest(selectDeliverables(deliverables, [node([])]), [node([])])).toEqual([]);
    const nodes = [node(['最终/*.docx'])];
    const selected = selectDeliverables(
      [...deliverables, { ...deliverables[0]!, name: '另一个名称' }],
      nodes,
    );
    expect(deliveryManifest(selected, nodes)).toHaveLength(1);
  });
  it('应用目录的 ** 交付嵌套资源，单星号不会越过目录', () => {
    const outputs = [
      { path: 'site/oasis-app.json', size: 50 },
      { path: 'site/index.html', size: 100 },
      { path: 'site/assets/js/game.js', size: 200 },
      { path: 'other/secret.txt', size: 9 },
    ];
    const appNode = { ...node(['site/**']), outputs } as Node;
    expect(selectDeliverables(deliverables, [appNode])[0]?.files?.map((f) => f.path)).toEqual(
      outputs.slice(0, 3).map((f) => f.path),
    );
  });
});
