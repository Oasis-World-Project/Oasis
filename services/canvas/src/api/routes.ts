// canvas 的接口。/v1/* 经 gateway 给前端（只能看自己的）；/internal/* 给 conversation 和 harness。
import { ArtifactQuery, UploadLookupBody, UploadQuery } from '@oasis/contracts/canvas';
import { parseWith, requireUserId, type ObjectStore, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { ArtifactService } from '../service/artifact-service.ts';
import type { UploadService } from '../service/upload-service.ts';
import { sendStored } from './send-stored.ts';

const IdParams = z.object({ id: z.uuid() });
const DownloadQuery = z.object({ download: z.enum(['0', '1']).default('0') });

export function registerRoutes(
  app: ServiceApp,
  services: { uploads: UploadService; artifacts: ArtifactService; store: ObjectStore },
  options: { maxBytes: number },
): void {
  const { uploads, artifacts, store } = services;
  // 上传的请求体就是文件本身（前端一律用 application/octet-stream 发，类型按文件名定）
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: options.maxBytes },
    (_request, body, done) => done(null, body),
  );

  app.post('/v1/uploads', { bodyLimit: options.maxBytes }, async (request, reply) => {
    const { name } = parseWith(UploadQuery, request.query);
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(415).send({
        error: {
          code: 'unsupported_media_type',
          message: '请用 application/octet-stream 上传文件',
          requestId: request.id,
        },
      });
    }
    return reply.code(201).send(await uploads.upload(requireUserId(request), name, request.body));
  });

  app.get('/v1/uploads/:id', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { download } = parseWith(DownloadQuery, request.query);
    const row = await uploads.owned(requireUserId(request), id);
    return sendStored(request, reply, store, { ...row, download: download === '1' });
  });

  // ---- 成果（ADR 0007 §8–9）----
  app.get('/v1/artifacts', async (request) => {
    const filter = parseWith(ArtifactQuery, request.query);
    return { artifacts: await artifacts.list(requireUserId(request), filter) };
  });

  app.get('/v1/artifacts/:id', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return artifacts.toBody(await artifacts.get(requireUserId(request), id));
  });

  app.get('/v1/artifacts/:id/content', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { download } = parseWith(DownloadQuery, request.query);
    const row = await artifacts.get(requireUserId(request), id);
    return sendStored(request, reply, store, { ...row, download: download === '1' });
  });

  app.post('/internal/uploads/lookup', async (request) => {
    const { ownerId, ids } = parseWith(UploadLookupBody, request.body);
    return { uploads: await uploads.lookup(ownerId, ids) };
  });

  app.get('/internal/uploads/:id/content', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { row, content } = await uploads.internalContent(id);
    return reply.type(row.contentType).send(content);
  });
}
