// harness 只有内部接口（gateway 不转发 /internal）：task 等服务用它启动运行、看进度、追问、停止、取消。
import { RunMessageBody, StartRunBody } from '@oasis/contracts/harness';
import { parseWith, type ServiceApp } from '@oasis/service-kit';
import { z } from 'zod';
import type { RunService } from '../service/run-service.ts';

const RunParams = z.object({ runId: z.uuid() });
const FileParams = RunParams.extend({ '*': z.string().min(1).max(500) });
const TextsQuery = z.object({
  maxChars: z.coerce.number().int().positive().max(50_000).default(8_000),
});
const EventsQuery = z.object({
  after: z.coerce.number().int().min(-1).default(-1),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export function registerRoutes(app: ServiceApp, runs: RunService): void {
  /** 启动一次运行：立即返回（202），运行在后台进行，结束时发出 harness.run.finished */
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

  /** 文字类产出（给关卡检查用），总长最多 maxChars */
  app.get('/internal/runs/:runId/texts', async (request) => {
    const { runId } = parseWith(RunParams, request.params);
    const { maxChars } = parseWith(TextsQuery, request.query);
    return runs.texts(runId, maxChars);
  });

  /** 读一个产出文件（out/ 下的相对路径） */
  app.get('/internal/runs/:runId/files/*', async (request, reply) => {
    const { runId, '*': path } = parseWith(FileParams, request.params);
    const file = await runs.file(runId, path);
    return reply.type(file.contentType).send(file.content);
  });

  /** 用户追问或补充要求（只对运行中的节点有效） */
  app.post('/internal/runs/:runId/messages', async (request, reply) => {
    const { runId } = parseWith(RunParams, request.params);
    const { text } = parseWith(RunMessageBody, request.body);
    await runs.message(runId, text);
    return reply.code(202).send();
  });

  /** 停止：存下产出和会话，之后可以用 continueFrom 接着做 */
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
}
