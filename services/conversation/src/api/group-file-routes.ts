// 群文件的接口：列表、读内容、删除；删一个任务；一条消息带的文件；工作台「任务」页签要的消息。非成员一律 404。
import { Readable } from 'node:stream';
import { z } from 'zod';
import { fileResponseHeaders, parseWith, requireUserId, type ServiceApp } from '@oasis/service-kit';
import type { GroupFiles } from '../service/group-files.ts';

const Id = z.object({ id: z.uuid() });
const FileParams = Id.extend({ fileId: z.uuid() });
const Download = z.object({ download: z.enum(['1']).optional() });

export function registerGroupFileRoutes(app: ServiceApp, files: GroupFiles): void {
  /** 文件内容边读边传：类型按存的时候定的，网页在沙箱里显示（见 fileResponseHeaders） */
  const headersOf = (file: Awaited<ReturnType<GroupFiles['content']>>, download?: string) => ({
    ...fileResponseHeaders(file.contentType, file.name, download === '1'),
    'cache-control': 'no-store',
    ...(file.size ? { 'content-length': file.size } : {}),
  });
  const bodyOf = (file: Awaited<ReturnType<GroupFiles['content']>>) =>
    file.body ? Readable.fromWeb(file.body) : '';

  app.get('/v1/groups/:id/files', async (request) => ({
    files: await files.list(requireUserId(request), parseWith(Id, request.params).id),
  }));
  app.get('/v1/groups/:id/files/:fileId/content', async (request, reply) => {
    const { id, fileId } = parseWith(FileParams, request.params);
    const { download } = parseWith(Download, request.query);
    const file = await files.content(requireUserId(request), id, fileId);
    return reply.headers(headersOf(file, download)).send(bodyOf(file));
  });
  /** 从群文件里删掉一个：传它的人和群主可以，AI 交的只有群主可以 */
  app.delete('/v1/groups/:id/files/:fileId', async (request, reply) => {
    const { id, fileId } = parseWith(FileParams, request.params);
    await files.remove(requireUserId(request), id, fileId, request.id);
    return reply.code(204).send();
  });
  /** 删掉群里的一个任务（画布里删，只有群主）：任务卡和它交的文件，聊天记录留着 */
  app.delete('/v1/groups/:id/tasks/:runId', async (request, reply) => {
    const { id, runId } = parseWith(Id.extend({ runId: z.uuid() }), request.params);
    await files.removeTask(requireUserId(request), id, runId, request.id);
    return reply.code(204).send();
  });
  /** 一条消息带的文件（群，或两个好友的私聊） */
  app.get('/v1/groups/:id/attachments/:fileId/content', async (request, reply) => {
    const { id, fileId } = parseWith(FileParams, request.params);
    const { download } = parseWith(Download, request.query);
    const file = await files.attachment(requireUserId(request), id, fileId);
    return reply.headers(headersOf(file, download)).send(bodyOf(file));
  });
  /** 工作台「任务」页签：最近动过手的那些轮里 AI 的话和任务卡 */
  app.get('/v1/groups/:id/work', async (request) =>
    files.work(requireUserId(request), parseWith(Id, request.params).id),
  );
}
