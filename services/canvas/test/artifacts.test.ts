// 成果登记进画布（ADR 0007 §8–10）：任务完成时复制交付文件、幂等、同步路径；列表、读取（分段）。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { unzipSync, strFromU8 } from 'fflate';
import type { TaskStatusChangedData } from '@oasis/contracts/events';
import { createService, createServiceClient, type ServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { categoryOf, safeSegment, uniqueName } from '../src/service/naming.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { memoryArtifacts, memoryStore, memoryUploads } from './memory.ts';

const KAI = '00000000-0000-4000-8000-000000000001';
const MIA = '00000000-0000-4000-8000-000000000002';
const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';
const COPY = '20000000-0000-4000-8000-000000000001';
const IMAGE = '20000000-0000-4000-8000-000000000002';
const TALK = '20000000-0000-4000-8000-000000000003';
const T3 = '10000000-0000-4000-8000-000000000003';
const SESSION = '30000000-0000-4000-8000-000000000001';
/** 转给 model-gateway 的数字人会话请求 */
const gatewayCalls: { method: string; path: string; headers?: object; body?: unknown }[] = [];

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
let finalFiles: { deliverable: string; nodeId: string; path: string; size: number }[] | undefined;
/** 修订任务 → 它修改的是哪个任务；canvas 换好新版后调 retire */
const revisionOf = new Map<string, string>();
/** 任务最近一次交付的时间（修改后再次交付时比成果登记得晚） */
const finishedAt = new Map<string, string>();
const retired: { taskId: string; replacedBy: string }[] = [];
task.get('/internal/tasks/:id', async (request) => {
  const { id } = request.params as { id: string };
  return {
    ...taskBody(id),
    revisionOf: revisionOf.get(id) ?? null,
    ...(finishedAt.has(id) ? { finishedAt: finishedAt.get(id) } : {}),
    ...(finalFiles === undefined ? {} : { deliveryFiles: finalFiles }),
  };
});
task.post('/internal/tasks/:id/retire', async (request, reply) => {
  retired.push({
    taskId: (request.params as { id: string }).id,
    replacedBy: (request.body as { replacedBy: string }).replacedBy,
  });
  return reply.code(204).send();
});
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
let uploadRows: ReturnType<typeof memoryUploads>;
let objects: ReturnType<typeof memoryStore>;
let service: ReturnType<typeof createArtifactService>;
let app: Awaited<ReturnType<typeof createService>>['app'];

beforeEach(async () => {
  finalFiles = undefined;
  fetched.length = 0;
  fileFailures = 0;
  revisionOf.clear();
  finishedAt.clear();
  retired.length = 0;
  gatewayCalls.length = 0;
  uploadRows = memoryUploads();
  repo = memoryArtifacts(uploadRows);
  const store = memoryStore();
  objects = store;
  service = createArtifactService({
    repo,
    uploads: uploadRows,
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
              repo: memoryUploads(),
              store,
            }),
            artifacts: service,
            store,
            harness: {
              json: async () => ({ maxMicro: 500, maxMs: 60_000, idleMs: 20_000 }),
            } as unknown as ServiceClient,
            modelGateway: {
              json: async (
                method: string,
                path: string,
                options: { headers?: object; body?: unknown },
              ) => {
                gatewayCalls.push({ method, path, headers: options.headers, body: options.body });
                if (path === '/internal/avatar/sessions') {
                  return {
                    sessionId: SESSION,
                    livekitUrl: 'wss://room',
                    livekitToken: 'lk',
                    sandbox: true,
                    maxSeconds: 300,
                    pricePerMinuteMicro: 0,
                    startedAt: '2026-11-01T12:00:00.000Z',
                  };
                }
                return undefined;
              },
            } as unknown as ServiceClient,
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
  it('数字人配置：合格的登记成数字人，不合格的照普通文件；开会话转给 model-gateway 并带上付费人', async () => {
    files['前台.oasis-avatar.json'] = JSON.stringify({
      name: '民宿前台',
      avatarId: '9c59a215-4c9f-478f-9d95-edca74c7b0d0',
      prompt: '你是山间民宿的前台',
      knowledge: [{ title: '早餐', content: '七点到九点半' }],
    });
    files['坏的.oasis-avatar.json'] = '{"name":""}';
    finalFiles = ['前台.oasis-avatar.json', '坏的.oasis-avatar.json'].map((path) => ({
      deliverable: '数字人',
      nodeId: COPY,
      path,
      size: files[path]!.length,
    }));
    await service.onTaskStatus(event(T3));
    const good = repo.rows.find((row) => row.path === '前台.oasis-avatar.json')!;
    const bad = repo.rows.find((row) => row.path === '坏的.oasis-avatar.json')!;
    expect(good).toMatchObject({
      category: 'app',
      avatarSpec: { name: '民宿前台', maxMinutes: 5 },
    });
    expect(bad.avatarSpec).toBeNull();
    expect(bad.category).not.toBe('app');

    const post = (url: string, user = KAI) =>
      app.inject({
        method: 'POST',
        url,
        headers: { [OASIS_HEADERS.userId]: user, 'content-type': 'application/json' },
        payload: '{}',
      });
    const started = await post(`/v1/artifacts/${good.id}/avatar-sessions`);
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ sessionId: SESSION, livekitUrl: 'wss://room' });
    expect(gatewayCalls[0]).toMatchObject({
      path: '/internal/avatar/sessions',
      headers: { [OASIS_HEADERS.payerId]: KAI },
      body: { artifactId: good.id, taskId: T3, spec: { name: '民宿前台' } },
    });
    expect((await post(`/v1/artifacts/${bad.id}/avatar-sessions`)).statusCode).toBe(422);
    expect((await post(`/v1/artifacts/${good.id}/avatar-sessions`, MIA)).statusCode).toBe(404);
    expect((await post(`/v1/avatar-sessions/${SESSION}/stop`)).statusCode).toBe(204);
    expect(gatewayCalls.at(-1)).toMatchObject({
      path: `/internal/avatar/sessions/${SESSION}/stop`,
      headers: { [OASIS_HEADERS.payerId]: KAI },
    });
  });

  it('仅同节点最终文件可组成应用，重放补齐描述且按属主取离线包', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/assets/game.js'] = 'document.title = "运行"';
    finalFiles = ['site/oasis-app.json', 'site/index.html', 'site/assets/game.js'].map((path) => ({
      deliverable: '应用',
      nodeId: COPY,
      path,
      size: files[path]!.length,
    }));
    await service.onTaskStatus(event(T1));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.category).toBe('app');
    expect(manifest.appSpec?.entry).toBe('index.html');
    expect((await service.application(KAI, manifest.id)).files.map((file) => file.path)).toEqual([
      'oasis-app.json',
      'index.html',
      'assets/game.js',
    ]);
    await expect(service.application(MIA, manifest.id)).rejects.toThrow();
    expect((await get(`/v1/artifacts/${manifest.id}/preview/quote`)).statusCode).toBe(200);
    expect((await get(`/v1/artifacts/${manifest.id}/preview/quote`, {}, MIA)).statusCode).toBe(404);
    manifest.appSpec = null;
    await service.onTaskStatus(event(T1));
    expect(repo.rows.find((row) => row.id === manifest.id)?.appSpec).toMatchObject({
      root: 'site',
    });
  });
  it('含隐藏文件的运行包不登记为应用，不能启动预览', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/.env'] = 'PRIVATE=sample';
    finalFiles = ['site/oasis-app.json', 'site/index.html', 'site/.env'].map((path) => ({
      deliverable: '应用',
      nodeId: COPY,
      path,
      size: files[path]!.length,
    }));
    await service.onTaskStatus(event(T2));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.appSpec).toBeNull();
    expect((await get(`/v1/artifacts/${manifest.id}/preview/quote`)).statusCode).toBe(422);
  });
  it('打包只包含自己的最终成果，ZIP 路径与桌面同步一致；超限或穿越拒绝', async () => {
    await service.onTaskStatus(event(T1));
    const response = await get(`/v1/tasks/${T1}/archive`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment');
    const entries = unzipSync(response.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(repo.rows.map((r) => r.syncPath).sort());
    for (const row of repo.rows) expect(strFromU8(entries[row.syncPath]!)).toBe(files[row.path]);
    expect((await get(`/v1/tasks/${T1}/archive`, {}, MIA)).statusCode).toBe(404);
    await expect(service.archive(KAI, T1, { bytes: 1, files: 100 })).rejects.toThrow();
    repo.rows[0]!.syncPath = '../逃逸.txt';
    expect((await get(`/v1/tasks/${T1}/archive`)).statusCode).toBe(422);
  });
  it('转换要求用户身份与二进制请求，按文件内容返回表格', async () => {
    const request = {
      method: 'POST' as const,
      url: '/v1/previews?name=a.csv',
      payload: Buffer.from('标题,值\n甲,10'),
      headers: { [OASIS_HEADERS.userId]: KAI, 'content-type': 'application/octet-stream' },
    };
    expect((await app.inject(request)).json()).toMatchObject({
      kind: 'table',
      sheets: [
        {
          rows: [
            ['标题', '值'],
            ['甲', '10'],
          ],
        },
      ],
    });
    expect(
      (await app.inject({ ...request, headers: { 'content-type': 'application/octet-stream' } }))
        .statusCode,
    ).toBe(401);
  });
  it('显式最终清单控制画布与同步，空清单不登记任何节点文件', async () => {
    finalFiles = [{ deliverable: '最终文案', nodeId: COPY, path: '首页文案.md', size: 20 }];
    await service.onTaskStatus(event(T1));
    expect(repo.rows.map((r) => [r.path, r.deliverable])).toEqual([['首页文案.md', '最终文案']]);
    expect(fetched).toEqual(['首页文案.md']);
    finalFiles = [];
    await service.onTaskStatus(event(T2));
    expect(repo.rows).toHaveLength(1);
  });
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

describe('修改成果：原地换新版、旧式修订替换、删除（ADR 0012）', () => {
  /** 旧流程登记的修订素材（打包的 ZIP 有自己的对象） */
  const legacyMaterial = (taskId: string) => {
    const id = '60000000-0000-4000-8000-000000000001';
    uploadRows.rows.set(id, {
      id,
      ownerId: KAI,
      name: '上一版成果.zip',
      contentType: 'application/zip',
      size: 3,
      sha256: 'b'.repeat(64),
      objectKey: `uploads/${KAI}/${id}`,
      state: 'ready',
      sourceTaskId: taskId,
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${KAI}/${id}`, {
      body: Buffer.from('zip'),
      type: 'application/zip',
    });
  };
  const keysOf = (taskId: string) =>
    [...objects.objects.keys()].filter((k) => k.startsWith(`artifacts/${taskId}/`));

  it('同一任务修改后再次交付：内容变了的原地换成新版（链接、同步路径不变，批注和截图清掉）；没变的不动；重投幂等', async () => {
    await service.onTaskStatus(event(T1));
    const copy = repo.rows.find((r) => r.taskId === T1 && r.path === '首页文案.md')!;
    const hero = repo.rows.find((r) => r.taskId === T1 && r.path === 'hero.png')!;
    const before = { id: copy.id, sha256: copy.sha256, syncPath: copy.syncPath };
    const heroSha = hero.sha256;
    const FRAME = '50000000-0000-4000-8000-0000000000f1';
    uploadRows.rows.set(FRAME, {
      id: FRAME,
      ownerId: KAI,
      name: '批注截图.png',
      contentType: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
      objectKey: `uploads/${FRAME}`,
      state: 'ready',
      sourceTaskId: null,
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${FRAME}`, { body: Buffer.from('png!'), type: 'image/png' });
    copy.annotations = [
      {
        id: '30000000-0000-4000-8000-000000000001',
        number: 1,
        note: '标题改短',
        page: null,
        time: null,
        quote: null,
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
        frame: FRAME,
      },
    ];
    const original = files['首页文案.md'];
    files['首页文案.md'] = '# 山居（改过）';
    finishedAt.set(T1, new Date(Date.now() + 1000).toISOString());
    try {
      await service.onTaskStatus(event(T1));
      await service.onTaskStatus(event(T1));
    } finally {
      files['首页文案.md'] = original!;
    }
    const rows = repo.rows.filter((r) => r.taskId === T1);
    expect(rows).toHaveLength(2);
    const updated = rows.find((r) => r.path === '首页文案.md')!;
    expect(updated.id).toBe(before.id);
    expect(updated.syncPath).toBe(before.syncPath);
    expect(updated.sha256).not.toBe(before.sha256);
    expect(updated.replacesSha256).toBe(before.sha256);
    expect(updated.annotations).toEqual([]);
    expect(uploadRows.rows.has(FRAME)).toBe(false);
    expect(objects.objects.has(`uploads/${FRAME}`)).toBe(false);
    expect(strFromU8(objects.objects.get(updated.objectKey)!.body)).toBe('# 山居（改过）');
    const same = rows.find((r) => r.path === 'hero.png')!;
    expect(same.sha256).toBe(heroSha);
    expect(same.replacesSha256).toBeNull();
    expect(retired).toEqual([]);
  });

  it('旧式修订任务交付后整体替换上一版：沿用同步路径、记下旧摘要、删旧对象和修订素材，再让 task 删上一版；重投幂等', async () => {
    await service.onTaskStatus(event(T1));
    const old = repo.rows.filter((r) => r.taskId === T1);
    const oldCopy = old.find((r) => r.path === '首页文案.md')!;
    legacyMaterial(T1);
    revisionOf.set(T2, T1);
    const original = files['首页文案.md'];
    files['首页文案.md'] = '# 山里的小木屋（新版）';
    try {
      await service.onTaskStatus(event(T2));
      await service.onTaskStatus(event(T2));
    } finally {
      files['首页文案.md'] = original!;
    }
    expect(repo.rows.filter((r) => r.taskId === T1)).toHaveLength(0);
    const fresh = repo.rows.filter((r) => r.taskId === T2);
    expect(fresh.map((r) => r.syncPath).sort()).toEqual(old.map((r) => r.syncPath).sort());
    const copy = fresh.find((r) => r.path === '首页文案.md')!;
    expect(copy.replacesSha256).toBe(oldCopy.sha256);
    expect(copy.sha256).not.toBe(oldCopy.sha256);
    expect(keysOf(T1)).toEqual([]);
    expect(uploadRows.rows.size).toBe(0);
    expect([...objects.objects.keys()].some((k) => k.startsWith('uploads/'))).toBe(false);
    expect(retired).toEqual([
      { taskId: T1, replacedBy: T2 },
      { taskId: T1, replacedBy: T2 },
    ]);
    const body = (await get(`/v1/artifacts/${copy.id}`)).json<{ replacesSha256: string }>();
    expect(body.replacesSha256).toBe(oldCopy.sha256);
  });

  it('旧式修订任务一个文件也没交出时不替换，上一版保留', async () => {
    await service.onTaskStatus(event(T1));
    revisionOf.set(T2, T1);
    finalFiles = [];
    await service.onTaskStatus(event(T2));
    expect(repo.rows.filter((r) => r.taskId === T1)).toHaveLength(2);
    expect(retired).toEqual([]);
  });

  it('任务被删除：成果行、对象和来自它的修订素材都删掉；重投没有副作用', async () => {
    await service.onTaskStatus(event(T1));
    legacyMaterial(T1);
    const deleted = {
      taskId: T1,
      ownerId: KAI,
      conversationId: null,
      replacedBy: null,
      deletedAt: '2026-10-31T08:00:00.000Z',
    };
    await service.onTaskDeleted(deleted);
    await service.onTaskDeleted(deleted);
    expect(repo.rows).toHaveLength(0);
    expect(uploadRows.rows.size).toBe(0);
    expect(objects.objects.size).toBe(0);
  });
});

describe('批注与批准（ADR 0012 §9）', () => {
  const send = (
    method: 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    user = KAI,
  ) =>
    app.inject({
      method,
      url,
      headers: { [OASIS_HEADERS.userId]: user },
      ...(payload === undefined ? {} : { payload }),
    });
  const note = (number: number, extra: object = {}) => ({
    id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    number,
    note: `第 ${number} 处要改`,
    page: null,
    time: null,
    quote: null,
    shape: null,
    ...extra,
  });

  it('整份替换批注：只能改自己的，编号不能重复，坐标必须在画面里', async () => {
    await service.onTaskStatus(event(T1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const url = `/v1/artifacts/${image.id}/annotations`;
    const ok = await send('PUT', url, {
      annotations: [
        note(1, { shape: { kind: 'ellipse', x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }),
        note(2, { time: 12.5, shape: { kind: 'pin', x: 0.5, y: 0.5 } }),
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ annotations: unknown[] }>().annotations).toHaveLength(2);
    expect((await get(`/v1/artifacts/${image.id}`)).json()).toMatchObject({
      annotations: [{ number: 1 }, { number: 2, time: 12.5 }],
    });
    expect((await send('PUT', url, { annotations: [note(1), note(1)] })).statusCode).toBe(400);
    expect(
      (
        await send('PUT', url, {
          annotations: [note(3, { shape: { kind: 'pin', x: 1.5, y: 0 } })],
        })
      ).statusCode,
    ).toBe(400);
    expect((await send('PUT', url, { annotations: [] }, MIA)).statusCode).toBe(404);
  });

  it('应用截图批注：截图必须是自己上传的；删掉批注或删除任务时截图一起删', async () => {
    await service.onTaskStatus(event(T1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const url = `/v1/artifacts/${image.id}/annotations`;
    const frame = (id: string, ownerId: string) => {
      uploadRows.rows.set(id, {
        id,
        ownerId,
        name: '批注截图.png',
        contentType: 'image/png',
        size: 4,
        sha256: 'a'.repeat(64),
        objectKey: `uploads/${id}`,
        state: 'ready',
        sourceTaskId: null,
        createdAt: new Date(),
      } as never);
      objects.objects.set(`uploads/${id}`, { body: Buffer.from('png!'), type: 'image/png' });
    };
    const A = '50000000-0000-4000-8000-00000000000a';
    const B = '50000000-0000-4000-8000-00000000000b';
    const OTHER = '50000000-0000-4000-8000-00000000000c';
    frame(A, KAI);
    frame(B, KAI);
    frame(OTHER, MIA);
    const pin = { kind: 'pin', x: 0.5, y: 0.5 };
    expect(
      (await send('PUT', url, { annotations: [note(1, { frame: OTHER, shape: pin })] })).statusCode,
    ).toBe(422);
    const ok = await send('PUT', url, {
      annotations: [note(1, { frame: A, shape: pin }), note(2, { frame: B, shape: pin })],
    });
    expect(ok.json<{ annotations: { frame: string }[] }>().annotations.map((a) => a.frame)).toEqual(
      [A, B],
    );
    await send('PUT', url, { annotations: [note(2, { frame: B, shape: pin })] });
    expect(uploadRows.rows.has(A)).toBe(false);
    expect(objects.objects.has(`uploads/${A}`)).toBe(false);
    expect(uploadRows.rows.has(B)).toBe(true);
    await service.onTaskDeleted({
      taskId: T1,
      ownerId: KAI,
      conversationId: null,
      replacedBy: null,
      deletedAt: '2026-11-04T08:00:00.000Z',
    });
    expect(uploadRows.rows.has(B)).toBe(false);
    expect(objects.objects.has(`uploads/${B}`)).toBe(false);
    // 别人的上传不受影响
    expect(uploadRows.rows.has(OTHER)).toBe(true);
  });

  it('批准是记号（界面已不显示，接口保留）：可以取消，只能改自己的', async () => {
    await service.onTaskStatus(event(T1));
    const copy = repo.rows.find((r) => r.path === '首页文案.md')!;
    const approved = await send('POST', `/v1/artifacts/${copy.id}/approval`);
    expect(approved.json<{ approvedAt: string | null }>().approvedAt).not.toBeNull();
    const undone = await send('DELETE', `/v1/artifacts/${copy.id}/approval`);
    expect(undone.json<{ approvedAt: string | null }>().approvedAt).toBeNull();
    expect(
      (await send('POST', `/v1/artifacts/${copy.id}/approval`, undefined, MIA)).statusCode,
    ).toBe(404);
  });
});
