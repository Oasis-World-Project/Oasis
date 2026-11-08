import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { createService, type ServiceClient } from '@oasis/service-kit';
import { registerRoutes } from '../src/api/routes.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { createModelPreviewService } from '../src/service/model-preview-service.ts';
import { memoryArtifacts, memoryStore, memoryUploads } from './memory.ts';

function setup() {
  const repo = memoryArtifacts(),
    store = memoryStore(),
    owner = randomUUID(),
    taskId = randomUUID(),
    nodeId = randomUUID();
  const calls: unknown[] = [];
  const logger = pino({ level: 'silent' });
  let inspectedSha: string | undefined, taskHeaders: unknown;
  const task = {
    json: async () => {
      throw new Error('not used');
    },
    stream: async (_method: string, _path: string, options: { headers: unknown }) => {
      taskHeaders = options.headers;
      throw new Error('upstream owner check denied');
    },
  } as unknown as ServiceClient;
  const inspector = {
    json: async (_method: string, path: string, input: { body: { sha256: string } }) => {
      calls.push(input.body);
      return path.endsWith('/poster')
        ? { sha256: input.body.sha256, width: 2, height: 2 }
        : {
            status: 'ready',
            sha256: inspectedSha ?? input.body.sha256,
            report: {
              vertices: 3,
              triangles: 1,
              nodes: 1,
              images: 0,
              texturePixels: 0,
              animations: [],
              meshLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] },
              unchecked: ['实际尺寸'],
            },
          };
    },
  } as unknown as ServiceClient;
  const artifacts = createArtifactService({ repo, uploads: memoryUploads(), store, task, logger });
  const uploads = createUploadService({ repo: memoryUploads(), store, logger });
  const models = createModelPreviewService({ artifacts, uploads, store, task, inspector });
  async function add(path: string, content: Buffer | string, extra: object = {}) {
    const id = randomUUID(),
      body = Buffer.from(content),
      objectKey = `artifacts/${id}`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    await store.put(objectKey, body, 'application/octet-stream');
    await repo.insert({
      id,
      ownerId: owner,
      taskId,
      nodeId,
      path,
      name: path.split('/').at(-1)!,
      size: body.length,
      sha256,
      objectKey,
      contentType: 'application/octet-stream',
      category: 'threed',
      deliverable: '模型',
      taskTitle: '模型',
      conversationId: null,
      appSpec: null,
      avatarSpec: null,
      models: [],
      syncPath: `模型/${path}`,
      replacesSha256: null,
      ...extra,
    });
    return repo.rows.find((row) => row.id === id)!;
  }
  return {
    models,
    artifacts,
    uploads,
    owner,
    calls,
    store,
    repo,
    add,
    task,
    inspector,
    taskHeaders: () => taskHeaders,
    badInspection: () => {
      inspectedSha = '0'.repeat(64);
    },
  };
}
describe('受信模型预览描述', () => {
  it('检查前的原件读取也有并发上限，完成后能释放名额', async () => {
    const f = setup(),
      row = await f.add('model.glb', 'mesh');
    const read = f.store.read;
    const waiting: (() => void)[] = [];
    f.store.read = async (...args) => {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return read(...args);
    };
    const first = f.models.describe(f.owner, { kind: 'artifact', id: row.id });
    const second = f.models.describe(f.owner, { kind: 'artifact', id: row.id });
    for (let attempts = 0; waiting.length < 2 && attempts < 20; attempts++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(waiting).toHaveLength(2);
    expect(
      (await f.models.describe(f.owner, { kind: 'artifact', id: row.id })).glb,
    ).toBeUndefined();
    waiting.forEach((resolve) => resolve());
    expect((await first).glb).toBeDefined();
    expect((await second).glb).toBeDefined();
    f.store.read = read;
    expect((await f.models.describe(f.owner, { kind: 'artifact', id: row.id })).glb).toBeDefined();
  });
  it('HTTP 入口拒绝外部来源、缺失身份和其他用户，封面沿用同一所有权', async () => {
    const f = setup(),
      source = await f.add('source.blend', 'native'),
      poster = await f.add('poster.png', 'poster');
    await f.add(
      'oasis-model-preview.json',
      JSON.stringify({
        version: 1,
        source: { path: source.name, sha256: source.sha256 },
        poster: { path: poster.name, sha256: poster.sha256 },
      }),
    );
    const service = await createService(
      { name: 'canvas', env: {}, routes: (app) => registerRoutes(app, f, { maxBytes: 1024 }) },
      { PORT: '0', LOG_LEVEL: 'silent' },
    );
    try {
      const request = (body: object, owner: string = f.owner) =>
        service.app.inject({
          method: 'POST',
          url: '/v1/model-previews',
          headers: { 'x-oasis-user-id': owner },
          payload: body,
        });
      expect(
        (await request({ kind: 'artifact', id: source.id, url: 'https://evil.test/model.glb' }))
          .statusCode,
      ).toBe(400);
      expect((await request({ kind: 'artifact', id: source.id }, '')).statusCode).toBe(401);
      expect((await request({ kind: 'artifact', id: source.id }, randomUUID())).statusCode).toBe(
        404,
      );
      const own = await request({ kind: 'artifact', id: source.id });
      expect(own.statusCode).toBe(200);
      expect(own.json().poster.url).toContain('model-poster');
      const route = `/v1/artifacts/${source.id}/model-poster`;
      expect(
        (await service.app.inject({ url: route, headers: { 'x-oasis-user-id': randomUUID() } }))
          .statusCode,
      ).toBe(404);
      const image = await service.app.inject({
        url: route,
        headers: { 'x-oasis-user-id': f.owner },
      });
      expect(image.statusCode).toBe(200);
      expect(image.headers['x-oasis-file-sha256']).toBe(poster.sha256);
    } finally {
      await service.app.close();
    }
  });
  it('直接 GLB 绑定原件字节和摘要，不生成额外成果或同步文件', async () => {
    const f = setup(),
      row = await f.add('out/model.glb', 'binary-fixture');
    const files = f.repo.rows.length,
      objects = f.store.objects.size;
    const descriptor = await f.models.describe(f.owner, { kind: 'artifact', id: row.id });
    expect(descriptor.glb?.sha256).toBe(row.sha256);
    expect(descriptor.source.url).toBe(`/api/canvas/v1/artifacts/${row.id}/content`);
    expect(descriptor.source).not.toHaveProperty('objectKey');
    expect(f.repo.rows).toHaveLength(files);
    expect(f.store.objects.size).toBe(objects);
    await expect(
      f.models.describe(randomUUID(), { kind: 'artifact', id: row.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it('配套轻量 GLB、封面和视频只能来自同节点正式清单，保持原件身份', async () => {
    const f = setup(),
      source = await f.add('out/scene.blend', 'native'),
      glb = await f.add('out/light.glb', 'mesh'),
      poster = await f.add('out/poster.png', 'poster'),
      video = await f.add('out/turn.mp4', 'video');
    const ref = (row: typeof source) => ({ path: row.name, sha256: row.sha256 });
    await f.add(
      'out/oasis-model-preview.json',
      JSON.stringify({
        version: 1,
        source: ref(source),
        glb: ref(glb),
        poster: ref(poster),
        turntable: ref(video),
        simplified: true,
      }),
    );
    const descriptor = await f.models.describe(f.owner, { kind: 'artifact', id: source.id });
    expect(descriptor.source.sha256).toBe(source.sha256);
    expect(descriptor.glb?.sha256).toBe(glb.sha256);
    expect(descriptor.poster?.url).toBe(`/api/canvas/v1/artifacts/${source.id}/model-poster`);
    expect(descriptor.turntable?.sha256).toBe(video.sha256);
    expect(descriptor.simplified).toBe(true);
  });
  it.each(['foreign-node', 'wrong-hash', 'external-url', 'traversal', 'missing-final'])(
    '关联 %s 不能成为预览来源',
    async (mode) => {
      const f = setup(),
        source = await f.add('out/source.blend', 'native'),
        glb = await f.add(
          'out/preview.glb',
          'preview',
          mode === 'foreign-node' ? { nodeId: randomUUID() } : {},
        );
      const path =
        mode === 'external-url'
          ? 'https://evil.test/file.glb'
          : mode === 'traversal'
            ? '../preview.glb'
            : mode === 'missing-final'
              ? 'missing.glb'
              : glb.name;
      await f.add(
        'out/oasis-model-preview.json',
        JSON.stringify({
          version: 1,
          source: { path: source.name, sha256: source.sha256 },
          glb: { path, sha256: mode === 'wrong-hash' ? '0'.repeat(64) : glb.sha256 },
        }),
      );
      expect(
        (await f.models.describe(f.owner, { kind: 'artifact', id: source.id })).glb,
      ).toBeUndefined();
      expect(f.calls).toEqual([]);
    },
  );
  it('归档后对象被篡改或检查器返回其他摘要，都不能进入查看器', async () => {
    const f = setup(),
      row = await f.add('model.glb', 'mesh');
    f.badInspection();
    expect(
      (await f.models.describe(f.owner, { kind: 'artifact', id: row.id })).glb,
    ).toBeUndefined();
    f.store.objects.set(row.objectKey, {
      body: Buffer.from('evil'),
      type: 'application/octet-stream',
    });
    expect(
      (await f.models.describe(f.owner, { kind: 'artifact', id: row.id })).glb,
    ).toBeUndefined();
  });
  it('上传与未登记的节点文件沿用原所有权检查，不接受调用方给 URL', async () => {
    const f = setup();
    const upload = await f.uploads.upload(
      f.owner,
      'mesh.glb',
      Readable.from([Buffer.from('mesh')]),
      { maxBytes: 100 },
    );
    expect((await f.models.describe(f.owner, { kind: 'upload', id: upload.id })).glb).toBeDefined();
    await expect(
      f.models.describe(randomUUID(), { kind: 'upload', id: upload.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.models.describe(f.owner, {
        kind: 'task',
        taskId: randomUUID(),
        nodeId: randomUUID(),
        path: 'out/model.glb',
      }),
    ).rejects.toThrow('owner');
    expect(f.taskHeaders()).toEqual({ 'x-oasis-user-id': f.owner });
  });
});
