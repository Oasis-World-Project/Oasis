// 成果登记进画布（ADR 0007 §8–10）：任务完成时复制交付文件、幂等、同步路径；列表、读取（分段）。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { TaskStatusChangedData } from '@oasis/contracts/events';
import { createService, createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { categoryOf, safeSegment, uniqueName } from '../src/service/naming.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { memoryArtifacts, memoryStore } from './memory.ts';

const KAI = '00000000-0000-4000-8000-000000000001';
const MIA = '00000000-0000-4000-8000-000000000002';
const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';
const COPY = '20000000-0000-4000-8000-000000000001';
const IMAGE = '20000000-0000-4000-8000-000000000002';
const TALK = '20000000-0000-4000-8000-000000000003';

const files: Record<string, string> = {
  '首页文案.md': '# 山里的小木屋',
  'hero.png': 'png-bytes-0123456789',
  '结论.md': '用温馨风',
};

function node(id: string, model: string, outputs: string[], extra: object = {}) {
  return {
    id,
    key: id.slice(-4),
    title: id,
    kind: 'work',
    role: '',
    goal: 'g',
    model,
    checks: [],
    expects: [],
    tools: [],
    discussion: null,
    status: 'succeeded',
    attempts: 1,
    userNotes: [],
    reworks: 0,
    warning: null,
    summary: null,
    outputs: outputs.map((path) => ({ path, size: files[path]?.length ?? 0 })),
    spentMicro: 0,
    startedAt: null,
    finishedAt: null,
    ...extra,
  };
}

function taskBody(id: string) {
  return {
    id,
    title: '小木屋：首页?',
    brief: '',
    status: 'succeeded',
    attention: null,
    estimateMicro: null,
    spentMicro: 0,
    budgetLimitMicro: null,
    sheet: null,
    materials: [],
    acceptance: { unmet: [] },
    deliverables: [
      { name: '首页文案', form: 'Markdown', nodeId: COPY },
      { name: '首屏效果图', form: 'PNG', nodeId: IMAGE },
      // 同一个节点负责两样交付物：文件只登记一次
      { name: '首页文案（备份）', form: 'Markdown', nodeId: COPY },
      { name: '没人负责', form: 'x', nodeId: null },
    ],
    nodes: [
      node(COPY, 'deepseek/x', ['首页文案.md']),
      node(IMAGE, 'google/g', ['hero.png']),
      // 不负责交付物的中间节点：不登记
      node(TALK, 'anthropic/c', ['结论.md'], {
        kind: 'discussion',
        discussion: {
          participants: [{ name: '甲', model: 'deepseek/x', stance: '' }],
          rounds: 1,
          round: 1,
          transcript: [],
        },
      }),
    ],
    edges: [],
    createdAt: '2026-10-24T08:00:00.000Z',
    finishedAt: null,
  };
}

/** 假 task：任务详情和成果文件；fileFailures 次数内取文件会 500 */
const fetched: string[] = [];
let fileFailures = 0;
const task = Fastify();
task.get('/internal/tasks/:id', async (request) => taskBody((request.params as { id: string }).id));
task.get('/internal/tasks/:id/files/:nodeId/*', async (request, reply) => {
  const path = (request.params as { '*': string })['*'];
  fetched.push(path);
  if (fileFailures > 0) {
    fileFailures -= 1;
    return reply.code(500).send({ error: { code: 'x', message: 'x', requestId: 'r' } });
  }
  return reply.type('application/octet-stream').send(Buffer.from(files[path] ?? ''));
});
let taskUrl = '';
beforeAll(async () => {
  taskUrl = await task.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => task.close());

let repo: ReturnType<typeof memoryArtifacts>;
let service: ReturnType<typeof createArtifactService>;
let app: Awaited<ReturnType<typeof createService>>['app'];

beforeEach(async () => {
  fetched.length = 0;
  fileFailures = 0;
  repo = memoryArtifacts();
  const store = memoryStore();
  service = createArtifactService({
    repo,
    store,
    task: createServiceClient('task', taskUrl),
    logger: pino({ level: 'silent' }),
  });
  ({ app } = await createService(
    {
      name: 'canvas',
      env: {},
      routes: (instance) =>
        registerRoutes(
          instance,
          {
            uploads: createUploadService({
              repo: {
                insert: async () => {
                  throw new Error('不用');
                },
                find: async () => undefined,
                findOwned: async () => [],
              },
              store,
            }),
            artifacts: service,
            store,
          },
          { maxBytes: 1024 },
        ),
    },
    { PORT: '0', LOG_LEVEL: 'silent' },
  ));
});

const event = (taskId: string, status: TaskStatusChangedData['status'] = 'succeeded') => ({
  taskId,
  ownerId: KAI,
  conversationId: null,
  title: '小木屋：首页?',
  status,
  attention: null,
  estimateMicro: null,
  spentMicro: 0,
  changedAt: '2026-10-24T08:00:00.000Z',
});

const get = (url: string, headers: Record<string, string> = {}, user = KAI) =>
  app.inject({ url, headers: { [OASIS_HEADERS.userId]: user, ...headers } });

describe('任务完成时登记成果', () => {
  it('只登记负责交付物的节点交出的文件，一个文件一次；没完成的任务不登记', async () => {
    await service.onTaskStatus(event(T1, 'running'));
    expect(repo.rows).toHaveLength(0);

    await service.onTaskStatus(event(T1));
    expect(repo.rows.map((r) => [r.path, r.deliverable, r.category, r.models])).toEqual([
      ['首页文案.md', '首页文案', 'doc', ['deepseek/x']],
      ['hero.png', '首屏效果图', 'doc', ['google/g']],
    ]);
    // 任务名里 Windows 不允许的字符（这里是英文问号）换掉，全角冒号可以留着
    expect(repo.rows.map((r) => r.syncPath)).toEqual([
      '小木屋：首页_/首页文案.md',
      '小木屋：首页_/hero.png',
    ]);
  });

  it('事件重复到达不会重复登记；中途失败的重投时补上', async () => {
    fileFailures = 1;
    await expect(service.onTaskStatus(event(T1))).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
    await service.onTaskStatus(event(T1));
    await service.onTaskStatus(event(T1));
    expect(repo.rows).toHaveLength(2);
    // 第二次全部登记过了，不再取文件
    expect(fetched.filter((p) => p === 'hero.png')).toHaveLength(1);
  });

  it('同名的任务在电脑上放进不同的文件夹', async () => {
    await service.onTaskStatus(event(T1));
    await service.onTaskStatus(event(T2));
    expect(repo.rows.filter((r) => r.taskId === T2).map((r) => r.syncPath)).toEqual([
      '小木屋：首页_ (2)/首页文案.md',
      '小木屋：首页_ (2)/hero.png',
    ]);
  });
});

describe('画布接口', () => {
  it('列出自己的成果，可以按类别和任务筛选；别人的看不到', async () => {
    await service.onTaskStatus(event(T1));
    const all = (await get('/v1/artifacts')).json<{ artifacts: { name: string }[] }>();
    expect(all.artifacts.map((a) => a.name)).toEqual(['hero.png', '首页文案.md']);
    expect((await get('/v1/artifacts?category=media')).json()).toEqual({ artifacts: [] });
    expect(
      (await get(`/v1/artifacts?taskId=${T1}`)).json<{ artifacts: unknown[] }>().artifacts,
    ).toHaveLength(2);
    expect((await get('/v1/artifacts', {}, MIA)).json()).toEqual({ artifacts: [] });
    const id = repo.rows[0]!.id;
    expect((await get(`/v1/artifacts/${id}`, {}, MIA)).statusCode).toBe(404);
  });

  it('读内容：整个、分段（拖动进度）、超出范围；带沙箱头', async () => {
    await service.onTaskStatus(event(T1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const whole = await get(`/v1/artifacts/${image.id}/content`);
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe('png-bytes-0123456789');
    expect(whole.headers).toMatchObject({
      'content-type': 'image/png',
      'accept-ranges': 'bytes',
      'content-security-policy': 'sandbox',
    });

    const part = await get(`/v1/artifacts/${image.id}/content`, { range: 'bytes=4-8' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('bytes');
    expect(part.headers['content-range']).toBe('bytes 4-8/20');

    const beyond = await get(`/v1/artifacts/${image.id}/content`, { range: 'bytes=99-' });
    expect(beyond.statusCode).toBe(416);

    const download = await get(`/v1/artifacts/${image.id}/content?download=1`);
    expect(download.headers['content-disposition']).toBe("attachment; filename*=UTF-8''hero.png");
  });
});

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
