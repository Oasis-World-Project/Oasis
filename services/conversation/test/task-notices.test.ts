import type { TaskStatusChangedData } from '@oasis/contracts/events';
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationRepo, Message } from '../src/repo/conversation-repo.ts';
import { createTaskNotices } from '../src/service/task-notices.ts';

const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
const CONV = '3f2e1d0c-9b8a-4765-8432-10fedcba9876';
const TASK = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
const NODE = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
const EVENT = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';

/** 只用到这三个方法的内存仓库；同一个 eventId 只插一次 */
const rows: Message[] = [];
const repo = {
  findOwned: async (id: string, owner: string) =>
    id === CONV && owner === OWNER ? { id: CONV, modelKey: 'claude' } : undefined,
  async insertMessageOnce(m: Message) {
    if (rows.some((r) => (r.data as { eventId?: string }).eventId === m.data.eventId))
      return undefined;
    rows.push(m);
    return m;
  },
  hasDelivery: async (_c: string, taskId: string) =>
    rows.some((r) => r.kind === 'delivery' && (r.data as { taskId?: string }).taskId === taskId),
  touchConversation: async () => {},
} as unknown as ConversationRepo;

const task = Fastify();
let finalFiles: { deliverable: string; nodeId: string; path: string; size: number }[] | undefined;
task.get('/internal/tasks/:id', async () => ({
  id: TASK,
  title: '小木屋首页',
  brief: 'b',
  status: 'succeeded',
  attention: null,
  estimateMicro: 7200,
  spentMicro: 5000,
  budgetLimitMicro: 21600,
  sheet: null,
  acceptance: { unmet: ['不超过 80 字'] },
  ...(finalFiles === undefined ? {} : { deliveryFiles: finalFiles }),
  deliverables: [{ name: '首页文案', form: 'Markdown', nodeId: NODE }],
  nodes: [
    {
      id: NODE,
      key: 'home',
      title: '写首页',
      kind: 'work',
      role: '',
      goal: 'g',
      model: 'm',
      checks: [],
      expects: [],
      discussion: null,
      status: 'succeeded',
      attempts: 1,
      reworks: 1,
      userNotes: [],
      warning: '交付前检查没完全通过：语气温馨',
      summary: '写好了',
      outputs: [{ path: '首页.md', size: 120 }],
      spentMicro: 5000,
      startedAt: null,
      finishedAt: null,
    },
  ],
  edges: [],
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}));

let notices: ReturnType<typeof createTaskNotices>;
beforeAll(async () => {
  const url = await task.listen({ port: 0, host: '127.0.0.1' });
  notices = createTaskNotices({
    repo,
    task: createServiceClient('task', url),
    logger: pino({ level: 'silent' }),
  });
});
afterAll(() => task.close());
beforeEach(() => {
  finalFiles = undefined;
  rows.length = 0;
});

const event = (
  status: TaskStatusChangedData['status'],
  extra: Partial<TaskStatusChangedData> = {},
) => ({
  taskId: TASK,
  ownerId: OWNER,
  conversationId: CONV,
  title: '小木屋首页',
  status,
  attention: null,
  estimateMicro: 7200,
  spentMicro: 5000,
  changedAt: new Date().toISOString(),
  ...extra,
});

describe('任务的结果回到私聊', () => {
  it('使用 task 的显式最终清单；空清单不能回退到节点全部文件', async () => {
    finalFiles = [{ deliverable: '定稿', nodeId: NODE, path: '最终.md', size: 30 }];
    await notices.onStatusChanged(EVENT, event('succeeded'));
    expect(rows[0]?.data.files).toEqual(finalFiles);
    rows.length = 0;
    finalFiles = [];
    await notices.onStatusChanged(EVENT, event('succeeded'));
    expect(rows[0]?.data.files).toEqual([]);
  });
  it('完成：发交付消息（成果文件、没满足的地方、过程中的提醒）；同一个事件只发一次', async () => {
    await notices.onStatusChanged(EVENT, event('succeeded'));
    await notices.onStatusChanged(EVENT, event('succeeded'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'delivery',
      authorKind: 'ai',
      authorId: 'claude',
      data: {
        taskId: TASK,
        files: [{ deliverable: '首页文案', nodeId: NODE, path: '首页.md', size: 120 }],
        unmet: ['不超过 80 字'],
        warnings: ['「写首页」交付前检查没完全通过：语气温馨'],
        eventId: EVENT,
      },
    });
    expect(rows[0]!.content).toContain('「小木屋首页」已交付，有未满足项。');
    expect(rows[0]!.content).toContain('首页文案：首页.md');
    expect(rows[0]!.content).toContain('没完全满足的地方：\n- 不超过 80 字');
  });

  it('修改后再次交付：不再发到私聊（进度在画布上看，私聊里的 AI 被问起时才说）', async () => {
    await notices.onStatusChanged(EVENT, event('succeeded'));
    await notices.onStatusChanged('8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b', event('succeeded'));
    expect(rows).toHaveLength(1);
  });

  it('过程异常与检查状态只留工作流，不创建私聊提醒，重复事件也不发', async () => {
    for (const status of [
      'needs_attention',
      'failed',
      'running',
      'cancelled',
      'accepting',
    ] as const) {
      const data = event(status, {
        attention: { reason: 'checks_incomplete', nodeId: NODE, message: '证据不足' },
      });
      await notices.onStatusChanged(EVENT, data);
      await notices.onStatusChanged(EVENT, data);
    }
    expect(rows).toHaveLength(0);
  });

  it('不是从私聊来的任务、或会话不属于这个人：不发', async () => {
    await notices.onStatusChanged(EVENT, event('failed', { conversationId: null }));
    await notices.onStatusChanged(EVENT, event('failed', { ownerId: TASK }));
    expect(rows).toHaveLength(0);
  });
});

describe('任务被删除（ADR 0012）', () => {
  it('任务删除时它的卡片、交付消息、提醒一起删掉；不是这个人的会话、没有会话的不动', async () => {
    const removed: { conversationId: string; taskId: string }[] = [];
    const notices = createTaskNotices({
      repo: {
        findOwned: async (id: string, owner: string) =>
          id === CONV && owner === OWNER ? { id: CONV, modelKey: 'claude' } : undefined,
        removeTaskMessages: async (conversationId: string, taskId: string) => {
          removed.push({ conversationId, taskId });
          return 2;
        },
      } as unknown as ConversationRepo,
      task: createServiceClient('task', 'http://127.0.0.1:9'),
      logger: pino({ level: 'silent' }),
    });
    const base = { taskId: TASK, ownerId: OWNER, deletedAt: new Date().toISOString() };
    await notices.onDeleted({ ...base, conversationId: CONV, replacedBy: NODE });
    await notices.onDeleted({ ...base, conversationId: null, replacedBy: null });
    await notices.onDeleted({ ...base, ownerId: NODE, conversationId: CONV, replacedBy: null });
    expect(removed).toEqual([{ conversationId: CONV, taskId: TASK }]);
  });
});
