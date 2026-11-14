// 成果登记进画布：对话里一轮结束时复制这一轮新增和改过的文件、幂等、同步路径；
// 列表、读取（分段）、打包、删对话。
import { createHash } from 'node:crypto';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { ArtifactBody, RegisterRunArtifactsBody } from '@oasis/contracts/canvas';
import { unzipSync, strFromU8 } from 'fflate';
import { createService, createServiceClient, type ServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { memoryArtifacts, memoryStore, memoryUploads } from './memory.ts';

const KAI = '00000000-0000-4000-8000-000000000001';
const MIA = '00000000-0000-4000-8000-000000000002';
/** 一个对话：话题 S1 里先后两轮 R1、R2；新话题 S2 里一轮 R3 */
const CONVERSATION = '10000000-0000-4000-8000-000000000001';
const OTHER_CONVERSATION = '10000000-0000-4000-8000-000000000002';
const S1 = '20000000-0000-4000-8000-000000000001';
const S2 = '20000000-0000-4000-8000-000000000002';
const R1 = '30000000-0000-4000-8000-000000000001';
const R2 = '30000000-0000-4000-8000-000000000002';
const R3 = '30000000-0000-4000-8000-000000000003';
const AVATAR_SESSION = '40000000-0000-4000-8000-000000000001';
/** 转给 model-gateway 的数字人会话请求 */
const gatewayCalls: { method: string; path: string; headers?: object; body?: unknown }[] = [];

/** 话题工作区里 out/ 下的文件（后来的一轮可以改它们） */
const files: Record<string, string> = {};
const initialFiles = {
  '首页文案.md': '# 山里的小木屋',
  'hero.png': 'png-bytes-0123456789',
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 假 harness：一轮的产出文件；fileFailures 次数内取文件会 500 */
const fetched: string[] = [];
let fileFailures = 0;
const harness = Fastify();
harness.get('/internal/runs/:runId/files/*', async (request, reply) => {
  const path = (request.params as { '*': string })['*'];
  fetched.push(path);
  if (fileFailures > 0) {
    fileFailures -= 1;
    return reply.code(500).send({ error: { code: 'x', message: 'x', requestId: 'r' } });
  }
  const content = files[path];
  if (content === undefined)
    return reply
      .code(404)
      .send({ error: { code: 'file_not_found', message: 'x', requestId: 'r' } });
  return reply
    .type('application/octet-stream')
    .header('x-oasis-file-sha256', sha256(content))
    .send(Buffer.from(content));
});
let harnessUrl = '';
beforeAll(async () => {
  harnessUrl = await harness.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => harness.close());

let repo: ReturnType<typeof memoryArtifacts>;
let uploadRows: ReturnType<typeof memoryUploads>;
let objects: ReturnType<typeof memoryStore>;
let service: ReturnType<typeof createArtifactService>;
let app: Awaited<ReturnType<typeof createService>>['app'];

beforeEach(async () => {
  for (const key of Object.keys(files)) delete files[key];
  Object.assign(files, initialFiles);
  fetched.length = 0;
  fileFailures = 0;
  gatewayCalls.length = 0;
  uploadRows = memoryUploads();
  repo = memoryArtifacts();
  const store = memoryStore();
  objects = store;
  service = createArtifactService({
    repo,
    uploads: uploadRows,
    store,
    harness: createServiceClient('harness', harnessUrl),
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
            inspector: {
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
                    sessionId: AVATAR_SESSION,
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

/** 一轮结束时 conversation 发来的登记请求；默认是话题 S1 的第一轮，交出两份文件 */
const run = (
  runId: string,
  paths: string[] = ['首页文案.md', 'hero.png'],
  extra: Partial<RegisterRunArtifactsBody> = {},
): RegisterRunArtifactsBody => ({
  ownerId: KAI,
  conversationId: CONVERSATION,
  sessionId: S1,
  runId,
  topic: '小木屋：首页?',
  models: ['deepseek/x'],
  outputs: paths.map((path) => ({ path, size: Buffer.byteLength(files[path] ?? '') })),
  ...extra,
});

const get = (url: string, headers: Record<string, string> = {}, user = KAI) =>
  app.inject({ url, headers: { [OASIS_HEADERS.userId]: user, ...headers } });

describe('一轮结束时登记成果', () => {
  it('复制这一轮交出的文件，按话题放进同步文件夹；返回登记的成果；什么也没交出就不登记', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/artifacts/runs',
      payload: run(R1),
    });
    expect(response.statusCode).toBe(200);
    const { artifacts } = response.json<{ artifacts: ArtifactBody[] }>();
    // 按这一轮交出文件的顺序
    expect(artifacts.map((a) => [a.path, a.runId, a.sessionId, a.conversationId])).toEqual([
      ['首页文案.md', R1, S1, CONVERSATION],
      ['hero.png', R1, S1, CONVERSATION],
    ]);
    expect(repo.rows.map((r) => [r.path, r.category, r.models, r.topic])).toEqual([
      ['首页文案.md', 'doc', ['deepseek/x'], '小木屋：首页?'],
      ['hero.png', 'doc', ['deepseek/x'], '小木屋：首页?'],
    ]);
    // 话题名里 Windows 不允许的字符（这里是英文问号）换掉，全角冒号可以留着
    expect(repo.rows.map((r) => r.syncPath)).toEqual([
      '小木屋：首页_/首页文案.md',
      '小木屋：首页_/hero.png',
    ]);
    expect(strFromU8(objects.objects.get(`artifacts/${S1}/hero.png`)!.body)).toBe(
      'png-bytes-0123456789',
    );
    expect(await service.registerRun(run(R2, []))).toEqual([]);
    expect(repo.rows).toHaveLength(2);
  });

  it('重复登记同一轮不会重复，返回同样的成果；中途失败的重试时补上', async () => {
    fileFailures = 1;
    await expect(service.registerRun(run(R1))).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
    const first = await service.registerRun(run(R1));
    const again = await service.registerRun(run(R1));
    expect(repo.rows).toHaveLength(2);
    expect(again.map((a) => a.id)).toEqual(first.map((a) => a.id));
    // 第二次全部登记过了，不再取文件
    expect(fetched.filter((p) => p === 'hero.png')).toHaveLength(1);
  });

  it('同名的新话题在电脑上放进不同的文件夹；话题不属于这个人时拒绝', async () => {
    await service.registerRun(run(R1));
    await service.registerRun(run(R3, ['首页文案.md'], { sessionId: S2 }));
    expect(repo.rows.filter((r) => r.sessionId === S2).map((r) => r.syncPath)).toEqual([
      '小木屋：首页_ (2)/首页文案.md',
    ]);
    // 同一话题后来的一轮新增文件，放进同一个文件夹
    files['notes/提纲.md'] = '一、二、三';
    await service.registerRun(run(R2, ['notes/提纲.md']));
    expect(repo.rows.find((r) => r.path === 'notes/提纲.md')?.syncPath).toBe(
      '小木屋：首页_/notes/提纲.md',
    );
    await expect(service.registerRun(run(R2, [], { ownerId: MIA }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'session_owner',
    });
  });

  it('数字人配置：合格的登记成数字人，不合格的照普通文件；开会话转给 model-gateway 并带上付费人', async () => {
    files['前台.oasis-avatar.json'] = JSON.stringify({
      name: '民宿前台',
      avatarId: '9c59a215-4c9f-478f-9d95-edca74c7b0d0',
      prompt: '你是山间民宿的前台',
      knowledge: [{ title: '早餐', content: '七点到九点半' }],
    });
    files['坏的.oasis-avatar.json'] = '{"name":""}';
    await service.registerRun(run(R1, ['前台.oasis-avatar.json', '坏的.oasis-avatar.json']));
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
    expect(started.json()).toMatchObject({ sessionId: AVATAR_SESSION, livekitUrl: 'wss://room' });
    expect(gatewayCalls[0]).toMatchObject({
      path: '/internal/avatar/sessions',
      headers: { [OASIS_HEADERS.payerId]: KAI },
      body: { artifactId: good.id, spec: { name: '民宿前台' } },
    });
    expect((await post(`/v1/artifacts/${bad.id}/avatar-sessions`)).statusCode).toBe(422);
    expect((await post(`/v1/artifacts/${good.id}/avatar-sessions`, MIA)).statusCode).toBe(404);
    expect((await post(`/v1/avatar-sessions/${AVATAR_SESSION}/stop`)).statusCode).toBe(204);
    expect(gatewayCalls.at(-1)).toMatchObject({
      path: `/internal/avatar/sessions/${AVATAR_SESSION}/stop`,
      headers: { [OASIS_HEADERS.payerId]: KAI },
    });
  });

  it('应用：话题里的文件组成应用；重复登记时补齐描述', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/assets/game.js'] = 'document.title = "运行"';
    const appFiles = ['site/oasis-app.json', 'site/index.html', 'site/assets/game.js'];
    await service.registerRun(run(R1, appFiles));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.category).toBe('app');
    expect(manifest.appSpec?.entry).toBe('index.html');
    // 画面转发式的平台容器预览已删除
    expect((await get(`/v1/artifacts/${manifest.id}/preview/quote`)).statusCode).toBe(404);
    manifest.appSpec = null;
    await service.registerRun(run(R1, appFiles));
    expect(repo.rows.find((row) => row.id === manifest.id)?.appSpec).toMatchObject({
      root: 'site',
    });
  });

  it('含隐藏文件的运行包不登记为应用', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/.env'] = 'PRIVATE=sample';
    await service.registerRun(run(R1, ['site/oasis-app.json', 'site/index.html', 'site/.env']));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.appSpec).toBeNull();
  });
});

describe('后来的一轮改了成果；删对话', () => {
  it('内容变了的原地换成新版（链接、同步路径不变，批注和截图清掉）；没变的不动；重复登记幂等', async () => {
    await service.registerRun(run(R1));
    const copy = repo.rows.find((r) => r.path === '首页文案.md')!;
    const hero = repo.rows.find((r) => r.path === 'hero.png')!;
    const before = { id: copy.id, sha256: copy.sha256, syncPath: copy.syncPath };
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
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${FRAME}`, { body: Buffer.from('png!'), type: 'image/png' });
    copy.annotations = [
      {
        id: '30000000-0000-4000-8000-0000000000a1',
        number: 1,
        note: '标题改短',
        page: null,
        time: null,
        quote: null,
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
        frame: FRAME,
      },
    ];
    files['首页文案.md'] = '# 山居（改过）';
    fetched.length = 0;
    // hero.png 没变：harness 报了摘要，canvas 不再取
    const second = run(R2);
    second.outputs[1]!.sha256 = sha256(files['hero.png']!);
    const changed = await service.registerRun(second);
    expect(changed.map((a) => a.path)).toEqual(['首页文案.md']);
    expect(fetched).toEqual(['首页文案.md']);
    expect((await service.registerRun(second)).map((a) => a.id)).toEqual([before.id]);

    expect(repo.rows).toHaveLength(2);
    const updated = repo.rows.find((r) => r.path === '首页文案.md')!;
    expect(updated.id).toBe(before.id);
    expect(updated.syncPath).toBe(before.syncPath);
    expect(updated.runId).toBe(R2);
    expect(updated.sha256).not.toBe(before.sha256);
    expect(updated.replacesSha256).toBe(before.sha256);
    expect(updated.annotations).toEqual([]);
    expect(uploadRows.rows.has(FRAME)).toBe(false);
    expect(objects.objects.has(`uploads/${FRAME}`)).toBe(false);
    expect(strFromU8(objects.objects.get(updated.objectKey)!.body)).toBe('# 山居（改过）');
    const same = repo.rows.find((r) => r.path === 'hero.png')!;
    expect(same).toMatchObject({ sha256: hero.sha256, replacesSha256: null, runId: R1 });
  });

  it('删对话：成果行、对象和批注截图都删掉；重复调用没有副作用；别的对话、别人的不受影响', async () => {
    await service.registerRun(run(R1));
    await service.registerRun(
      run(R3, ['首页文案.md'], { conversationId: OTHER_CONVERSATION, sessionId: S2 }),
    );
    const FRAME = '50000000-0000-4000-8000-0000000000f2';
    uploadRows.rows.set(FRAME, {
      id: FRAME,
      ownerId: KAI,
      name: '批注截图.png',
      contentType: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
      objectKey: `uploads/${FRAME}`,
      state: 'ready',
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${FRAME}`, { body: Buffer.from('png!'), type: 'image/png' });
    repo.rows.find((r) => r.sessionId === S1)!.annotations = [
      {
        id: '30000000-0000-4000-8000-0000000000a2',
        number: 1,
        note: '这里',
        page: null,
        time: null,
        quote: null,
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
        frame: FRAME,
      },
    ];
    const purge = (ownerId: string) =>
      app.inject({
        method: 'POST',
        url: `/internal/conversations/${CONVERSATION}/purge`,
        payload: { ownerId },
      });
    expect((await purge(MIA)).statusCode).toBe(204);
    expect(repo.rows).toHaveLength(3);
    expect((await purge(KAI)).statusCode).toBe(204);
    expect((await purge(KAI)).statusCode).toBe(204);
    expect(repo.rows.map((r) => r.sessionId)).toEqual([S2]);
    expect([...objects.objects.keys()]).toEqual([`artifacts/${S2}/首页文案.md`]);
    expect(uploadRows.rows.has(FRAME)).toBe(false);
  });
});

describe('画布接口', () => {
  it('列出自己的成果，可以按类别、对话、话题筛选；别人的看不到', async () => {
    await service.registerRun(run(R1));
    const all = (await get('/v1/artifacts')).json<{ artifacts: { name: string }[] }>();
    expect(all.artifacts.map((a) => a.name)).toEqual(['hero.png', '首页文案.md']);
    expect((await get('/v1/artifacts?category=media')).json()).toEqual({ artifacts: [] });
    for (const query of [`conversationId=${CONVERSATION}`, `sessionId=${S1}`])
      expect(
        (await get(`/v1/artifacts?${query}`)).json<{ artifacts: unknown[] }>().artifacts,
      ).toHaveLength(2);
    expect((await get(`/v1/artifacts?sessionId=${S2}`)).json()).toEqual({ artifacts: [] });
    expect((await get('/v1/artifacts', {}, MIA)).json()).toEqual({ artifacts: [] });
    const id = repo.rows[0]!.id;
    expect((await get(`/v1/artifacts/${id}`, {}, MIA)).statusCode).toBe(404);
  });

  it('读内容：整个、分段（拖动进度）、超出范围；带沙箱头', async () => {
    await service.registerRun(run(R1));
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

  it('打包一个话题：只含自己的成果，ZIP 路径与桌面同步一致；超限或穿越拒绝', async () => {
    await service.registerRun(run(R1));
    const response = await get(`/v1/topics/${S1}/archive`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment');
    const entries = unzipSync(response.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(repo.rows.map((r) => r.syncPath).sort());
    for (const row of repo.rows) expect(strFromU8(entries[row.syncPath]!)).toBe(files[row.path]);
    expect((await get(`/v1/topics/${S1}/archive`, {}, MIA)).statusCode).toBe(404);
    await expect(service.archive(KAI, S1, { bytes: 1, files: 100 })).rejects.toThrow();
    repo.rows[0]!.syncPath = '../逃逸.txt';
    expect((await get(`/v1/topics/${S1}/archive`)).statusCode).toBe(422);
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
});

describe('让 AI 改：查成果、取内容', () => {
  it('核对是这个人的；withFiles 列出应用目录、网页所在目录里的文件；取内容带摘要', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/assets/game.js'] = 'document.title = "运行"';
    files['pages/about.html'] = '<img src="./hero.png">';
    files['pages/hero.png'] = 'png';
    await service.registerRun(
      run(R1, [
        '首页文案.md',
        'hero.png',
        'site/oasis-app.json',
        'site/index.html',
        'site/assets/game.js',
        'pages/about.html',
        'pages/hero.png',
      ]),
    );
    const id = (path: string) => repo.rows.find((r) => r.path === path)!.id;
    const lookup = (ownerId: string, ids: string[], withFiles = false) =>
      app.inject({
        method: 'POST',
        url: '/internal/artifacts/lookup',
        payload: { ownerId, ids, withFiles },
      });
    const paths = (list: ArtifactBody[]) => list.map((a) => a.path);

    const plain = (await lookup(KAI, [id('hero.png'), id('首页文案.md')])).json<{
      artifacts: ArtifactBody[];
      files: ArtifactBody[];
    }>();
    expect(paths(plain.artifacts)).toEqual(['hero.png', '首页文案.md']);
    expect(plain.files).toEqual([]);

    const wide = await lookup(
      KAI,
      [id('site/oasis-app.json'), id('pages/about.html'), id('首页文案.md')],
      true,
    );
    expect(paths(wide.json<{ files: ArtifactBody[] }>().files)).toEqual([
      'pages/about.html',
      'pages/hero.png',
      'site/assets/game.js',
      'site/index.html',
      'site/oasis-app.json',
      '首页文案.md',
    ]);
    // 根目录下的网页：话题里的文件都可能被它引用
    files['index.html'] = '<img src="hero.png">';
    await service.registerRun(run(R2, ['index.html']));
    expect(
      (await lookup(KAI, [id('index.html')], true)).json<{ files: unknown[] }>().files,
    ).toHaveLength(8);

    const missing = '50000000-0000-4000-8000-000000000099';
    expect((await lookup(MIA, [id('hero.png')])).statusCode).toBe(404);
    expect((await lookup(KAI, [id('hero.png'), missing])).statusCode).toBe(404);

    const content = await app.inject({ url: `/internal/artifacts/${id('hero.png')}/content` });
    expect(content.body).toBe('png-bytes-0123456789');
    expect(content.headers['x-oasis-file-sha256']).toBe(sha256('png-bytes-0123456789'));
    expect((await app.inject({ url: `/internal/artifacts/${missing}/content` })).statusCode).toBe(
      404,
    );
  });
});

describe('批注与批准', () => {
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
    await service.registerRun(run(R1));
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

  it('应用截图批注：截图必须是自己上传的；删掉批注或删对话时截图一起删', async () => {
    await service.registerRun(run(R1));
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
    await service.purgeConversation(KAI, CONVERSATION);
    expect(uploadRows.rows.has(B)).toBe(false);
    expect(objects.objects.has(`uploads/${B}`)).toBe(false);
    // 别人的上传不受影响
    expect(uploadRows.rows.has(OTHER)).toBe(true);
  });

  it('批准是记号（界面已不显示，接口保留）：可以取消，只能改自己的', async () => {
    await service.registerRun(run(R1));
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
