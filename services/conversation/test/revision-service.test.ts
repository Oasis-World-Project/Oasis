// 修改成果（ADR 0012，2026-11-05 改为在原任务里接着做）：修改意见交给原任务，私聊里出现意见和同一个任务的卡片。
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, ConversationRepo, Message } from '../src/repo/conversation-repo.ts';
import { createRevisionService, revisionText } from '../src/service/revision-service.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const TASK = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const ATTACHED = 'cccccccc-0000-4000-8000-000000000001';

/** 假 task：记下收到的修改，已交付的才能改 */
let delivered = true;
const asked: { taskId: string; body: Record<string, unknown> }[] = [];
const server = Fastify();
server.post('/internal/tasks/:id/revise', async (request, reply) => {
  const { id } = request.params as { id: string };
  asked.push({ taskId: id, body: request.body as Record<string, unknown> });
  if (!delivered)
    return reply.code(409).send({
      error: { code: 'task_not_delivered', message: '这个任务还没交付或正在修改', requestId: 'r' },
    });
  return {
    id,
    title: '小木屋首页',
    brief: '最初的需求',
    status: 'running',
    attention: null,
    estimateMicro: null,
    spentMicro: 0,
    budgetLimitMicro: null,
    sheet: null,
    acceptance: null,
    materials: [],
    deliverables: [],
    nodes: [],
    edges: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
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
  delivered = true;
  asked.length = 0;
  rows.length = 0;
  service = createRevisionService({
    repo,
    task: createServiceClient('task', url),
    logger: pino({ level: 'silent' }),
  });
});
type Notes = Parameters<ReturnType<typeof createRevisionService>['revise']>[0]['annotations'];
const notes: Notes = [
  { file: 'hero.png', number: 2, where: '画面右下', note: '换成夜景', snapshot: '批注-hero.png' },
  { file: '首页文案.md', number: 1, where: '', note: '这句太长', quote: '山里的小木屋欢迎你' },
];
const revise = (
  attachments = [] as { id: string; name: string; size: number; contentType: string }[],
  annotations: Notes = [],
  request = '标题改成「山居」',
) =>
  service.revise({
    conversation,
    ownerId: OWNER,
    taskId: TASK,
    request,
    annotations,
    attachments,
    requestId: 'r',
  });

describe('发起修改', () => {
  it('交给原任务接着改，不新建任务；附件成为素材；私聊里出现修改意见和同一个任务的卡片', async () => {
    const messages = await revise(
      [{ id: ATTACHED, name: '批注-hero.png', size: 3, contentType: 'image/png' }],
      notes,
      '整体再温馨一点',
    );
    const text = revisionText('整体再温馨一点', notes);
    expect(asked).toEqual([
      {
        taskId: TASK,
        body: {
          ownerId: OWNER,
          request: text,
          materials: [{ uploadId: ATTACHED, name: '批注-hero.png', size: 3 }],
        },
      },
    ]);
    expect(messages.map((m) => m.kind)).toEqual(['text', 'task']);
    expect(messages[0]).toMatchObject({
      authorKind: 'user',
      content: `修改「小木屋首页」：${text}`,
      data: { attachments: [expect.objectContaining({ id: ATTACHED })] },
    });
    expect(messages[1]?.data).toEqual({ taskId: TASK, revisionOf: TASK });
  });

  it('还没交付或正在修改的不能再改，私聊里不留消息', async () => {
    delivered = false;
    await expect(revise()).rejects.toMatchObject({ code: 'task_not_delivered' });
    expect(rows).toHaveLength(0);
  });
});

describe('修改意见的文字', () => {
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
