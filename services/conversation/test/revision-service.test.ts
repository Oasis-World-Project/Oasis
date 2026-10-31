// 修改成果（ADR 0012）：修改意见并进任务单和说明，带上一版文件新建修订任务。
import { createServiceClient, HttpError } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TaskSheet } from '@oasis/contracts/task';
import type { Conversation, ConversationRepo, Message } from '../src/repo/conversation-repo.ts';
import {
  createRevisionService,
  revisedSheet,
  revisionBrief,
  revisionText,
} from '../src/service/revision-service.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const OLD = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const NEW = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';
const KEPT = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000002';
const PREV = 'bbbbbbbb-0000-4000-8000-000000000001';
const ATTACHED = 'cccccccc-0000-4000-8000-000000000001';

const sheet: TaskSheet = {
  title: '小木屋首页',
  deliverables: [{ name: '首页文案', form: 'Markdown' }],
  criteria: ['不超过 80 字'],
  style: ['温馨'],
  budgetMicro: null,
  assumptions: [],
  materials: ['民宿照片.jpg'],
  requirements: [
    { id: 'r1', text: '不超过 80 字', sources: [{ kind: 'request', quote: '不超过 80 字' }] },
  ],
};

describe('任务单与说明', () => {
  it('修改意见成为有来源的要求和验收点，加上「其余保持一致」；再改一次编号递增', () => {
    const first = revisedSheet({ title: 't', sheet, deliverables: [] }, '标题改成「山居」', [
      { uploadId: PREV, name: '上一版-首页文案.md', size: 1 },
    ]);
    expect(first.requirements?.at(-1)).toEqual({
      id: 'revision-1',
      text: '标题改成「山居」',
      sources: [{ kind: 'revision', quote: '标题改成「山居」' }],
    });
    expect(first.requirements?.[0]?.id).toBe('r1');
    expect(first.criteria).toEqual(['不超过 80 字', '修改意见已落实：标题改成「山居」']);
    expect(first.style).toContain('只改修改意见涉及的地方，其余与上一版保持一致');
    expect(first.materials).toEqual(['上一版-首页文案.md']);
    const second = revisedSheet({ title: 't', sheet: first, deliverables: [] }, '再短一点', []);
    expect(second.requirements?.at(-1)?.id).toBe('revision-2');
    expect(second.style.filter((s) => s.startsWith('只改'))).toHaveLength(1);
  });

  it('直接给方案建的任务没有任务单：按交付物补一张', () => {
    const built = revisedSheet(
      { title: '海报', sheet: null, deliverables: [{ name: '海报', form: 'PNG', nodeId: null }] },
      '换成蓝色',
      [],
    );
    expect(built).toMatchObject({ title: '海报', deliverables: [{ name: '海报', form: 'PNG' }] });
  });

  it('说明附上文件对照和原话；超长时保留上一版说明的开头和完整的修改部分', () => {
    const files = [
      {
        material: '上一版-首页文案.md',
        path: '首页文案.md',
        deliverable: '首页文案',
        approved: false,
      },
    ];
    const brief = revisionBrief('最初的需求', '标题改成「山居」', files, [{ name: '参考.png' }]);
    expect(brief).toContain('最初的需求');
    expect(brief).toContain('- 上一版-首页文案.md：上一版的 首页文案.md（交付物「首页文案」）');
    expect(brief).toContain('- 参考.png');
    // 「保持一致」不等于像素不变：生成的画面优先参考上一版改（实测：要求像素不变时节点手工合成到超时）
    expect(brief).toContain('不要求像素完全相同');
    const long = revisionBrief(`开头${'x'.repeat(30_000)}`, '改', files, []);
    expect(long.length).toBeLessThanOrEqual(20_000);
    expect(long.startsWith('开头')).toBe(true);
    expect(long).toContain('### 修改意见（用户原话）\n改');
  });
});

/** 假 task 和 canvas */
let previousStatus = 'succeeded';
let previousMaterials: { uploadId: string; name: string; size: number }[] = [];
const created: Record<string, unknown>[] = [];
const roomAsked: number[] = [];
const server = Fastify();
server.get('/internal/tasks/:id', async () => ({
  id: OLD,
  title: '小木屋首页',
  brief: '最初的需求',
  status: previousStatus,
  attention: null,
  estimateMicro: null,
  spentMicro: 0,
  budgetLimitMicro: null,
  sheet,
  acceptance: null,
  materials: previousMaterials,
  deliverables: [{ name: '首页文案', form: 'Markdown', nodeId: null }],
  nodes: [],
  edges: [],
  createdAt: new Date().toISOString(),
  finishedAt: null,
}));
server.post('/internal/tasks', async (request, reply) => {
  created.push(request.body as Record<string, unknown>);
  return reply.code(201).send({ id: NEW });
});
server.post('/internal/uploads/lookup', async (request) => {
  const { ids, partial } = request.body as { ids: string[]; partial: boolean };
  expect(partial).toBe(true);
  return {
    uploads: ids
      .filter((id) => id === KEPT)
      .map((id) => ({
        id,
        name: '民宿照片.jpg',
        size: 10,
        contentType: 'image/jpeg',
        createdAt: new Date().toISOString(),
      })),
  };
});
server.post('/internal/revisions/materials', async (request) => {
  const { room } = request.body as { room: number };
  roomAsked.push(room);
  return {
    materials: [{ uploadId: PREV, name: '上一版-首页文案.md', size: 20 }],
    files: [{ material: '上一版-首页文案.md', path: '首页文案.md', deliverable: '首页文案' }],
  };
});
let url = '';
beforeAll(async () => {
  url = await server.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => server.close());

const rows: Message[] = [];
const repo = {
  async insertMessage(m: Message) {
    const row = { ...m, id: `00000000-0000-4000-8000-${String(rows.length).padStart(12, '0')}` };
    rows.push(row as Message);
    return row;
  },
  touchConversation: async () => {},
} as unknown as ConversationRepo;
const conversation = { id: CONV, modelKey: 'claude' } as Conversation;
let service: ReturnType<typeof createRevisionService>;
beforeEach(() => {
  previousStatus = 'succeeded';
  previousMaterials = [
    { uploadId: KEPT, name: '民宿照片.jpg', size: 10 },
    { uploadId: GONE, name: '上一版-旧文案.md', size: 5 },
  ];
  created.length = 0;
  roomAsked.length = 0;
  rows.length = 0;
  service = createRevisionService({
    repo,
    task: createServiceClient('task', url),
    canvas: createServiceClient('canvas', url),
    logger: pino({ level: 'silent' }),
  });
});
type Notes = Parameters<ReturnType<typeof createRevisionService>['revise']>[0]['annotations'];
const revise = (
  attachments = [] as { id: string; name: string; size: number; contentType: string }[],
  annotations: Notes = [],
  request = '标题改成「山居」',
) =>
  service.revise({
    conversation,
    ownerId: OWNER,
    taskId: OLD,
    request,
    annotations,
    attachments,
    requestId: 'r',
  });

describe('发起修改', () => {
  it('带上还在的原素材、上一版文件和新附件建修订任务；私聊里出现修改意见和任务卡', async () => {
    const messages = await revise([
      { id: ATTACHED, name: '参考.png', size: 3, contentType: 'image/png' },
    ]);
    expect(roomAsked).toEqual([18]);
    expect(created).toHaveLength(1);
    const body = created[0] as {
      revisionOf: string;
      conversationId: string;
      materials: { uploadId: string }[];
      sheet: TaskSheet;
      brief: string;
    };
    expect(body.revisionOf).toBe(OLD);
    expect(body.conversationId).toBe(CONV);
    expect(body.materials.map((m) => m.uploadId)).toEqual([KEPT, PREV, ATTACHED]);
    expect(body.sheet.materials).toEqual(['民宿照片.jpg', '上一版-首页文案.md', '参考.png']);
    expect(body.sheet.requirements?.at(-1)?.sources[0]).toEqual({
      kind: 'revision',
      quote: '标题改成「山居」',
    });
    expect(body.brief).toContain('## 本次是修改');
    expect(messages.map((m) => m.kind)).toEqual(['text', 'task']);
    expect(messages[0]).toMatchObject({
      authorKind: 'user',
      content: '修改「小木屋首页」：标题改成「山居」',
      data: { attachments: [expect.objectContaining({ id: ATTACHED })] },
    });
    expect(messages[1]?.data).toEqual({ taskId: NEW, revisionOf: OLD });
  });

  it('还没交付的不能改；素材放不下时拒绝', async () => {
    previousStatus = 'running';
    await expect(revise()).rejects.toMatchObject({ code: 'task_not_delivered' });
    previousStatus = 'succeeded';
    previousMaterials = Array.from({ length: 20 }, () => ({
      uploadId: KEPT,
      name: 'x',
      size: 1,
    }));
    // 去重后只剩 1 个；再附 19 个就放不下上一版文件
    const many = Array.from({ length: 19 }, (_, i) => ({
      id: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `${i}.png`,
      size: 1,
      contentType: 'image/png',
    }));
    const error = await revise(many).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('too_many_materials');
    expect(created).toHaveLength(0);
  });
});

describe('批注与批准（ADR 0012 §9）', () => {
  const notes = [
    {
      file: 'hero.png',
      number: 2,
      where: '画面右下',
      note: '换成夜景',
      snapshot: '批注-hero.png',
    },
    { file: '首页文案.md', number: 1, where: '', note: '这句太长', quote: '山里的小木屋欢迎你' },
  ];

  it('每条批注一行：文件、位置、意见、引用原文、见哪张截图', () => {
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
  });

  it('说明里列出用户已批准的文件', () => {
    const brief = revisionBrief(
      'b',
      '改',
      [
        { material: '上一版-hero.png', path: 'hero.png', deliverable: '图', approved: true },
        { material: '上一版-a.md', path: 'a.md', deliverable: '文', approved: false },
      ],
      [],
    );
    expect(brief).toContain(
      '### 用户已批准的文件（除非修改意见或批注提到，否则原样保留）\n- 上一版-hero.png',
    );
    expect(brief).not.toContain('- 上一版-a.md\n');
  });

  it('只带批注、不写意见也能发起：任务单、说明和私聊消息用同一段文字', async () => {
    const messages = await revise([], notes, '');
    const body = created[0] as { sheet: TaskSheet; brief: string };
    const text = revisionText('', notes);
    expect(body.sheet.requirements?.at(-1)?.text).toBe(text);
    expect(body.brief).toContain(`### 修改意见（用户原话）\n${text}`);
    expect(messages[0]?.content).toBe(`修改「小木屋首页」：${text}`);
  });
});
