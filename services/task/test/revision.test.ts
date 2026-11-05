// 修改成果直接交给 AI 团队（ADR 0012，2026-11-05）：修改意见整理成文字，附件在 canvas 核对后并进素材。
import type { ServiceClient } from '@oasis/service-kit';
import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { createRevisions, revisionText } from '../src/service/revision.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const TASK = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const SHOT = 'cccccccc-0000-4000-8000-000000000001';

const notes = [
  { file: 'hero.png', number: 2, where: '画面右下', note: '换成夜景', snapshot: '批注-hero.png' },
  { file: '首页文案.md', number: 1, where: '', note: '这句太长', quote: '山里的小木屋欢迎你' },
];

function setup(lookup: (body: unknown) => unknown) {
  const revised: unknown[] = [];
  const looked: unknown[] = [];
  const revisions = createRevisions({
    workflows: {
      revise: async (taskId, body) => {
        revised.push({ taskId, body });
        return { id: taskId } as never;
      },
    },
    canvas: {
      json: async (_method: string, _path: string, opts: { body: unknown }) => {
        looked.push(opts.body);
        return lookup(opts.body);
      },
    } as unknown as ServiceClient,
  });
  return { revisions, revised, looked };
}

describe('修改成果', () => {
  it('交给原任务接着改：意见、批注、参数写成一段文字，附件核对后（标成已用上）并进素材', async () => {
    const { revisions, revised, looked } = setup(() => ({
      uploads: [{ id: SHOT, name: '批注-hero.png', size: 3, contentType: 'image/png' }],
    }));
    await revisions.revise(
      OWNER,
      TASK,
      { request: '整体再温馨一点', annotations: notes, parameters: [], attachments: [SHOT] },
      'r',
    );
    expect(looked).toEqual([{ ownerId: OWNER, ids: [SHOT], claim: true }]);
    expect(revised).toEqual([
      {
        taskId: TASK,
        body: {
          ownerId: OWNER,
          request: revisionText('整体再温馨一点', notes),
          materials: [{ uploadId: SHOT, name: '批注-hero.png', size: 3 }],
        },
      },
    ]);
  });

  it('没带附件不查 canvas；附件不是自己的：400', async () => {
    const plain = setup(() => ({ uploads: [] }));
    await plain.revisions.revise(
      OWNER,
      TASK,
      { request: '改短', annotations: [], parameters: [], attachments: [] },
      'r',
    );
    expect(plain.looked).toEqual([]);
    const missing = setup(() => {
      throw new HttpError(404, 'upload_not_found', '没有');
    });
    await expect(
      missing.revisions.revise(
        OWNER,
        TASK,
        { request: '改短', annotations: [], parameters: [], attachments: [SHOT] },
        'r',
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'attachment_not_found' });
    expect(missing.revised).toEqual([]);
  });

  it('每条批注一行：文件、位置、意见、引用原文、见哪张截图；参数单独列出', () => {
    expect(revisionText('整体再温馨一点', notes)).toBe(
      [
        '整体再温馨一点',
        '批注：',
        '2.「hero.png」画面右下：换成夜景（见截图 批注-hero.png）',
        '1.「首页文案.md」：这句太长（原文「山里的小木屋欢迎你」）',
      ].join('\n'),
    );
    expect(revisionText('', notes.slice(1))).toBe(
      '批注：\n1.「首页文案.md」：这句太长（原文「山里的小木屋欢迎你」）',
    );
    expect(revisionText('', [], [{ file: 'a.mp4', name: '字幕字号', value: '大' }])).toBe(
      '参数：\n「a.mp4」字幕字号：大',
    );
  });
});
