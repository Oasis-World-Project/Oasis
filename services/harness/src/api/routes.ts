// harness 只有内部接口（gateway 不转发 /internal）：conversation 用它开一轮、看进度、插话、停止、
// 取消、清理对话；canvas 用它读产出文件。harness 不调 inspector。
import { RunMessageBody, StartRunBody } from '@oasis/contracts/harness';
import { HttpError, parseWith, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { RunService } from '../service/run-service.ts';

const RunParams = z.object({ runId: z.uuid() });
const ConversationParams = z.object({ conversationId: z.uuid() });
const FileParams = RunParams.extend({ '*': z.string().min(1).max(500) });
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export function registerRoutes(app: ServiceApp, runs: RunService): void {
  app.get('/internal/execution/environment', () => runs.environment());

  /** 开一轮：立即返回（202），这一轮在后台进行 */
  app.post('/internal/runs', async (request, reply) => {
    const body = parseWith(StartRunBody, request.body);
    return reply.code(202).send(await runs.start(body));
  });

  app.get('/internal/runs/:runId', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    return runs.get(runId);
  });

  /** 运行过程中的事件，按序号增量拉取（after = 已经拿到的最大序号） */
  app.get('/internal/runs/:runId/events', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { after, limit } = parseWith(EventsQuery, request.query);
    return { events: await runs.events(runId, after, limit) };
  });

  /** 读一个产出文件（out/ 下的相对路径）：画布登记成果时复制 */
  app.get('/internal/runs/:runId/files/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.fileStream(runId, path);
    return reply
      .type(file.contentType)
      .header('content-length', file.size)
      .header('x-oasis-file-sha256', file.sha256 ?? '')
      .send(file.content);
  });

  /** 读这一轮工作目录里的一个文件（相对 /workspace）：进度页预览中间产物 */
  app.get('/internal/runs/:runId/workspace/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.workspaceFile(runId, path);
    return reply.type(file.contentType).header('content-length', file.size).send(file.content);
  });

  /** 用户在这一轮进行中插话 */
  app.post('/internal/runs/:runId/messages', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { text } = parseWith(RunMessageBody, request.body);
    await runs.message(runId, text);
    return reply.code(202).send();
  });

  /** 停止：存下产出（会话留在持久工作目录里），下一轮接着做 */
  app.post('/internal/runs/:runId/stop', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    await runs.stop(runId);
    return reply.code(202).send();
  });

  app.post('/internal/runs/:runId/cancel', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    await runs.cancel(runId);
    return reply.code(202).send();
  });

  /** 删对话、开新话题：删掉这个对话的运行记录、产出包和持久工作目录（真删除，可重复调用） */
  app.post('/internal/conversations/:conversationId/purge', async (request, reply) => {
    const { conversationId } = parseWith(ConversationParams, request.params);
    if (!(await runs.purgeConversation(conversationId)))
      throw new HttpError(409, 'run_active', '这个对话还有一轮没结束，先停下再删');
    return reply.code(204).send();
  });
}
