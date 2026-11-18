// canvas 的接口。/v1/* 经 gateway 给前端（只能看自己的）；/internal/* 给 conversation、harness 等。
import {
  AnnotationList,
  ArtifactLookupBody,
  ArtifactQuery,
  PurgeArtifactsBody,
  RegisterRunArtifactsBody,
  UploadDeleteBody,
  UploadLookupBody,
  UploadQuery,
} from '@oasis/contracts/canvas';
import {
  fileResponseHeaders,
  HttpError,
  parseWith,
  requireUserId,
  type ObjectStore,
  type ServiceClient,
  type ServiceApp,
} from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import type { ArchiveLimits } from '../service/archive.ts';
import type { ArtifactService } from '../service/artifact-service.ts';
import type { UploadService } from '../service/upload-service.ts';
import {
  createPreviewService,
  defaultPreviewLimits,
  type PreviewLimits,
} from '../service/preview-service.ts';
import { registerAvatarRoutes } from './avatar-routes.ts';
import { sendStored } from './send-stored.ts';
import { ModelPreviewSource } from '@oasis/contracts/model-preview';
import { createModelPreviewService } from '../service/model-preview-service.ts';

const IdParams = z.object({ id: z.uuid() });
const RunParams = z.object({ runId: z.uuid() });
const ConversationParams = z.object({ conversationId: z.uuid() });
const DownloadQuery = z.object({ download: z.enum(['0', '1']).default('0') });

export function registerRoutes(
  app: ServiceApp,
  services: {
    uploads: UploadService;
    artifacts: ArtifactService;
    store: ObjectStore;
    /** 模型预览前的检查；没配时不提供模型预览 */
    inspector?: ServiceClient;
    /** 数字人会话；没配时不提供 */
    modelGateway?: ServiceClient;
  },
  options: {
    maxBytes: number;
    uploadConcurrency?: number;
    transferTimeoutMs?: number;
    preview?: PreviewLimits;
    archive?: ArchiveLimits;
  },
): void {
  const { uploads, artifacts, store, inspector } = services;
  if (services.modelGateway) {
    registerAvatarRoutes(app, { artifacts, modelGateway: services.modelGateway });
  }
  const previewLimits = options.preview ?? defaultPreviewLimits;
  const preview = createPreviewService(previewLimits);
  const models = createModelPreviewService({ artifacts, uploads, store, inspector });
  let archiving = false;
  let uploading = 0;
  // 上传的请求体就是文件本身（前端一律用 application/octet-stream 发，类型按文件名定）
  app.addContentTypeParser('application/octet-stream', {}, (_request, body, done) =>
    done(null, body),
  );

  app.post('/v1/uploads', { bodyLimit: options.maxBytes }, async (request, reply) => {
    const { name } = parseWith(UploadQuery, request.query);
    if (!(request.body instanceof Readable)) {
      return reply.code(415).send({
        error: {
          code: 'unsupported_media_type',
          message: '请用 application/octet-stream 上传文件',
          requestId: request.id,
        },
      });
    }
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > options.maxBytes)
      throw new HttpError(413, 'upload_size', '文件超过上传上限');
    if (uploading >= (options.uploadConcurrency ?? 2))
      throw new HttpError(503, 'upload_busy', '上传任务较多，请稍后重试');
    uploading++;
    const source = request.body;
    const timer = setTimeout(
      () => source.destroy(new Error('上传超时')),
      options.transferTimeoutMs ?? 600_000,
    );
    try {
      return reply.code(201).send(
        await uploads.upload(requireUserId(request), name, source, {
          maxBytes: options.maxBytes,
          ...(request.headers['content-length'] ? { size: length } : {}),
        }),
      );
    } finally {
      clearTimeout(timer);
      uploading--;
    }
  });

  app.get('/v1/uploads/:id', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { download } = parseWith(DownloadQuery, request.query);
    const row = await uploads.owned(requireUserId(request), id);
    return sendStored(request, reply, store, { ...row, download: download === '1' });
  });

  // ---- 成果----
  app.get('/v1/artifacts', async (request) => {
    const filter = parseWith(ArtifactQuery, request.query);
    const user = requireUserId(request),
      rows = await artifacts.list(user, filter);
    const decorated = [];
    for (const row of rows) decorated.push(await models.decorate(user, row));
    return { artifacts: decorated };
  });

  app.get('/v1/artifacts/:id', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    const user = requireUserId(request),
      row = artifacts.toBody(await artifacts.get(user, id));
    return models.decorate(user, row);
  });

  // ---- 批注与批准----
  app.put('/v1/artifacts/:id/annotations', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    const { annotations } = parseWith(AnnotationList, request.body);
    return artifacts.setAnnotations(requireUserId(request), id, annotations);
  });
  app.post('/v1/artifacts/:id/approval', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return artifacts.setApproval(requireUserId(request), id, true);
  });
  app.delete('/v1/artifacts/:id/approval', async (request) => {
    const { id } = parseWith(IdParams, request.params);
    return artifacts.setApproval(requireUserId(request), id, false);
  });

  app.post('/v1/model-previews', (request) =>
    models.describe(requireUserId(request), parseWith(ModelPreviewSource, request.body)),
  );
  app.get('/v1/artifacts/:id/model-poster', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { row, content, size, sha256 } = await models.poster(requireUserId(request), id);
    return reply
      .headers({
        ...fileResponseHeaders(row.contentType, row.name, false),
        'content-length': size,
        'x-oasis-file-sha256': sha256,
      })
      .send(content);
  });

  app.get('/v1/artifacts/:id/content', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { download } = parseWith(DownloadQuery, request.query);
    const row = await artifacts.get(requireUserId(request), id);
    return sendStored(request, reply, store, { ...row, download: download === '1' });
  });

  app.post('/v1/previews', { bodyLimit: previewLimits.inputBytes }, async (request, reply) => {
    requireUserId(request);
    const { name } = parseWith(UploadQuery, request.query);
    if (!(request.body instanceof Readable))
      return reply.code(415).send({
        error: {
          code: 'unsupported_media_type',
          message: '请发送文件二进制内容',
          requestId: request.id,
        },
      });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > previewLimits.inputBytes)
        throw new HttpError(413, 'preview_size', '文件超过预览上限');
      chunks.push(bytes);
    }
    return preview(name, Buffer.concat(chunks));
  });

  /** 打包下载：同一时间只打一个包 */
  async function sendArchive(
    request: FastifyRequest,
    reply: FastifyReply,
    pack: (limits: ArchiveLimits) => Promise<{ name: string; content: Readable }>,
  ) {
    if (archiving)
      return reply.code(503).send({
        error: { code: 'archive_busy', message: '正在打包，请稍后重试', requestId: request.id },
      });
    archiving = true;
    reply.raw.once('close', () => {
      archiving = false;
    });
    try {
      const result = await pack(options.archive ?? { bytes: 100 * 1024 * 1024, files: 1000 });
      return reply
        .headers(fileResponseHeaders('application/zip', result.name, true))
        .send(result.content);
    } catch (error) {
      archiving = false;
      throw error;
    }
  }

  /** 一个任务（一轮）的成果打包下载 */
  app.get('/v1/runs/:runId/archive', async (request, reply) => {
    const owner = requireUserId(request);
    const { runId } = parseWith(RunParams, request.params);
    return sendArchive(request, reply, (limits) => artifacts.archive(owner, runId, limits));
  });

  /** 下载整个应用：应用目录里的全部文件 */
  app.get('/v1/artifacts/:id/archive', async (request, reply) => {
    const owner = requireUserId(request);
    const { id } = parseWith(IdParams, request.params);
    return sendArchive(request, reply, (limits) => artifacts.appArchive(owner, id, limits));
  });

  /** 登记对话里一轮做好的成果（进行中做好一个登记一个，结束时再登记一遍），返回这一轮的全部成果 */
  app.post('/internal/artifacts/runs', async (request) => ({
    artifacts: await artifacts.registerRun(parseWith(RegisterRunArtifactsBody, request.body)),
  }));

  /** 「让 AI 改」：核对成果是这个人的，列出改它们要用到的文件 */
  app.post('/internal/artifacts/lookup', async (request) => {
    const { ownerId, ids, withFiles } = parseWith(ArtifactLookupBody, request.body);
    return artifacts.lookup(ownerId, ids, withFiles);
  });

  /** 成果文件的内容：harness 拷进工作目录 */
  app.get('/internal/artifacts/:id/content', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { row, content } = await artifacts.internalContent(id);
    return reply
      .type(row.contentType)
      .header('content-length', row.size)
      .header('x-oasis-file-sha256', row.sha256 ?? '')
      .send(content);
  });

  /** 删对话（真删除）：删掉这个对话的成果和批注截图；可以重复调用 */
  app.post('/internal/conversations/:conversationId/purge', async (request, reply) => {
    const { conversationId } = parseWith(ConversationParams, request.params);
    const { ownerId } = parseWith(PurgeArtifactsBody, request.body);
    await artifacts.purgeConversation(ownerId, conversationId);
    return reply.code(204).send();
  });

  /** 删任务（真删除）：删掉这个人名下归在这一轮下的成果和批注截图；可以重复调用 */
  app.post('/internal/runs/:runId/purge', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { ownerId } = parseWith(PurgeArtifactsBody, request.body);
    await artifacts.purgeRun(ownerId, runId);
    return reply.code(204).send();
  });

  app.post('/internal/uploads/lookup', async (request) => {
    const { ownerId, ids, partial, claim } = parseWith(UploadLookupBody, request.body);
    return { uploads: await uploads.lookup(ownerId, ids, partial, claim) };
  });

  /** 彻底删除文件：对象和记录都删（消息被删、群被解散时 conversation 调用，2026-11-05 真删除） */
  app.post('/internal/uploads/delete', async (request) => {
    const { ownerId, ids } = parseWith(UploadDeleteBody, request.body);
    return { deleted: await uploads.remove(ownerId, ids) };
  });

  app.get('/internal/uploads/:id/content', async (request, reply) => {
    const { id } = parseWith(IdParams, request.params);
    const { row, content } = await uploads.internalContent(id);
    return reply
      .type(row.contentType)
      .header('content-length', row.size)
      .header('x-oasis-file-sha256', row.sha256 ?? '')
      .send(content);
  });
}
