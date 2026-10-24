// 素材上传：存、下载（只能下自己的、带安全响应头）、内部核对和取内容（ADR 0007 §3）。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { createService, createServiceClient } from '@oasis/service-kit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import type { Upload, UploadsRepo } from '../src/repo/uploads-repo.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { memoryArtifacts, memoryStore } from './memory.ts';

const KAI = '00000000-0000-4000-8000-000000000001';
const MIA = '00000000-0000-4000-8000-000000000002';

function memoryRepo(): UploadsRepo {
  const rows = new Map<string, Upload>();
  return {
    insert: async (upload) => {
      const row = { ...upload, createdAt: new Date('2026-10-23T08:00:00Z') };
      rows.set(row.id, row);
      return row;
    },
    find: async (id) => rows.get(id),
    findOwned: async (ownerId, ids) =>
      ids.flatMap((id) => {
        const row = rows.get(id);
        return row?.ownerId === ownerId ? [row] : [];
      }),
  };
}

async function app(maxBytes = 1024) {
  const store = memoryStore();
  const service = await createService(
    {
      name: 'canvas',
      env: {},
      routes: (instance) =>
        registerRoutes(
          instance,
          {
            uploads: createUploadService({ repo: memoryRepo(), store }),
            artifacts: createArtifactService({
              repo: memoryArtifacts(),
              store,
              task: createServiceClient('task', 'http://127.0.0.1:9'),
              logger: pino({ level: 'silent' }),
            }),
            store,
          },
          { maxBytes },
        ),
    },
    { PORT: '0', LOG_LEVEL: 'silent' },
  );
  return { app: service.app, store };
}

const upload = (
  instance: Awaited<ReturnType<typeof app>>['app'],
  name: string,
  body: Buffer,
  user = KAI,
) =>
  instance.inject({
    method: 'POST',
    url: `/v1/uploads?name=${encodeURIComponent(name)}`,
    headers: { 'content-type': 'application/octet-stream', [OASIS_HEADERS.userId]: user },
    payload: body,
  });

describe('上传素材', () => {
  it('存下文件，类型按扩展名定；自己能下载，别人下载不到', async () => {
    const { app: instance, store } = await app();
    const created = await upload(instance, '民宿照片.jpg', Buffer.from('jpeg-bytes'));
    expect(created.statusCode).toBe(201);
    const body = created.json<{ id: string; name: string; size: number; contentType: string }>();
    expect(body).toMatchObject({ name: '民宿照片.jpg', size: 10, contentType: 'image/jpeg' });
    expect([...store.objects.keys()]).toEqual([`uploads/${KAI}/${body.id}`]);

    const mine = await instance.inject({
      url: `/v1/uploads/${body.id}?download=1`,
      headers: { [OASIS_HEADERS.userId]: KAI },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toBe('jpeg-bytes');
    expect(mine.headers['content-security-policy']).toBe('sandbox');
    expect(mine.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('民宿照片.jpg')}`,
    );

    const theirs = await instance.inject({
      url: `/v1/uploads/${body.id}`,
      headers: { [OASIS_HEADERS.userId]: MIA },
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('超过大小上限、文件名带路径、不是二进制请求体都会被拒绝', async () => {
    const { app: instance } = await app(8);
    expect((await upload(instance, 'big.bin', Buffer.alloc(9))).statusCode).toBe(413);
    expect((await upload(instance, '../etc/passwd', Buffer.from('x'))).statusCode).toBe(400);
    const json = await instance.inject({
      method: 'POST',
      url: '/v1/uploads?name=a.json',
      headers: { 'content-type': 'application/json', [OASIS_HEADERS.userId]: KAI },
      payload: '{}',
    });
    expect(json.statusCode).toBe(415);
  });

  it('内部核对：都是这个人的才返回，有一个不是就 404；内部能取内容', async () => {
    const { app: instance } = await app();
    const a = (await upload(instance, 'a.md', Buffer.from('# A'))).json<{ id: string }>();
    const b = (await upload(instance, 'b.png', Buffer.from('png'), MIA)).json<{ id: string }>();

    const ok = await instance.inject({
      method: 'POST',
      url: '/internal/uploads/lookup',
      payload: { ownerId: KAI, ids: [a.id, a.id] },
    });
    expect(ok.json<{ uploads: { id: string }[] }>().uploads.map((u) => u.id)).toEqual([a.id]);

    const mixed = await instance.inject({
      method: 'POST',
      url: '/internal/uploads/lookup',
      payload: { ownerId: KAI, ids: [a.id, b.id] },
    });
    expect(mixed.statusCode).toBe(404);

    const content = await instance.inject({ url: `/internal/uploads/${b.id}/content` });
    expect(content.body).toBe('png');
    expect(content.headers['content-type']).toBe('image/png');
  });
});
