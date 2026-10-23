// canvas 的接口。/v1/* 经 gateway 给前端（只能看自己的）；/internal/* 给 conversation 和 harness。
import { UploadLookupBody, UploadQuery } from '@oasis/contracts/canvas';
import { fileResponseHeaders, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { UploadService } from '../service/upload-service.ts';

const IdParams = z.object({ id: z.uuid() });
const DownloadQuery = z.object({ download: z.enum(['0', '1']).default('0') });

export function registerRoutes(
  app: ServiceApp,
  uploads: UploadService,
  options: { maxBytes: number },
): void {
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
    const { row, content } = await uploads.download(requireUserId(request), id);
    return reply
      .headers(fileResponseHeaders(row.contentType, row.name, download === '1'))
      .send(content);
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
